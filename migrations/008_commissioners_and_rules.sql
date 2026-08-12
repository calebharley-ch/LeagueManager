-- ============================================================================
--  008 - co-commissioners, commissioner-only rules, and a privilege-escalation
--        fix that came with them
--
--  Run after 007. Additive and idempotent.
-- ============================================================================

-- ── Only the commissioner writes the rulebook ───────────────────────────────
--  Was: any member could insert. The rulebook is the league's record of what
--  was agreed, not a suggestion box.
drop policy if exists "propose rules in my league" on public.league_rules;
drop policy if exists "commissioner adds rules" on public.league_rules;
create policy "commissioner adds rules" on public.league_rules for insert to authenticated
  with check (proposer_id = auth.uid() and public.is_league_commissioner(league_id));


-- ── !! PRIVILEGE ESCALATION FIX ─────────────────────────────────────────────
--  The existing update policy on league_members is:
--
--    using (profile_id = auth.uid() or public.is_league_commissioner(league_id))
--
--  which is right for team_name and espn_team_id - you edit your own row. But
--  `role` is on the same row, so ANY manager could set their own role to
--  'commissioner' and take over the league. RLS cannot compare OLD to NEW, so
--  the column needs a trigger.
--
--  Also stops the last commissioner demoting themselves, which would leave the
--  league with nobody able to sync ESPN, invite anyone, or write a rule.
create or replace function public.guard_member_role()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_commish_count integer;
begin
  if new.role is distinct from old.role then
    if not public.is_league_commissioner(old.league_id) then
      raise exception 'Only a commissioner can change roles';
    end if;

    if old.role = 'commissioner' and new.role <> 'commissioner' then
      select count(*) into v_commish_count
        from public.league_members
       where league_id = old.league_id and role = 'commissioner';
      if v_commish_count <= 1 then
        raise exception 'A league must keep at least one commissioner';
      end if;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists league_members_guard_role on public.league_members;
create trigger league_members_guard_role
  before update on public.league_members
  for each row execute function public.guard_member_role();


-- ── Same protection on the way out ──────────────────────────────────────────
--  The delete policy already refuses to remove yourself, but a commissioner
--  could still delete the OTHER commissioner and then be removed by them in a
--  race. Cheap to guard.
create or replace function public.guard_member_delete()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_commish_count integer;
begin
  if old.role = 'commissioner' then
    select count(*) into v_commish_count
      from public.league_members
     where league_id = old.league_id and role = 'commissioner';
    if v_commish_count <= 1 then
      raise exception 'A league must keep at least one commissioner';
    end if;
  end if;
  return old;
end;
$$;

drop trigger if exists league_members_guard_delete on public.league_members;
create trigger league_members_guard_delete
  before delete on public.league_members
  for each row execute function public.guard_member_delete();
