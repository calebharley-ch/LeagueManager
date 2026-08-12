-- ============================================================================
--  014 - rule proposals for next season
--
--  Run after 013. Additive and idempotent.
--
--  !! SEPARATE FROM league_rules ON PURPOSE. The rulebook is what the league
--  has AGREED; this is what somebody wants to argue about at the draft. Mixing
--  them would mean a proposal nobody has voted on sitting in the book looking
--  like law, which is exactly the confusion the rulebook exists to prevent.
--
--  No voting engine here. The league votes in person - see the in-person draft
--  rule - so this records the idea and who raised it, and the commissioner
--  records the outcome afterwards. Adopting one writes a real rule into
--  league_rules and leaves the proposal marked adopted for the trail.
-- ============================================================================

do $$ begin create type proposal_status as enum ('open', 'adopted', 'declined');
exception when duplicate_object then null; end $$;

create table if not exists public.rule_proposals (
  id            uuid primary key default gen_random_uuid(),
  league_id     uuid not null references public.leagues(id) on delete cascade,
  proposer_id   uuid not null references public.profiles(id) on delete cascade,
  title         text not null,
  description   text,
  category      rule_category not null,
  target_season integer not null,
  status        proposal_status not null default 'open',
  resolved_by   uuid references public.profiles(id) on delete set null,
  resolved_at   timestamptz,
  created_at    timestamptz not null default now()
);

create index if not exists rule_proposals_league_idx
  on public.rule_proposals (league_id, status, created_at desc);

alter table public.rule_proposals enable row level security;

-- Everyone in the league reads them - the point is that anyone can see what has
-- been put forward.
drop policy if exists "proposals readable by league" on public.rule_proposals;
create policy "proposals readable by league" on public.rule_proposals for select to authenticated
  using (public.is_league_member(league_id));

-- ANY member can raise one. This is the one place in the app where a manager
-- writes something the commissioner did not initiate, and that is deliberate.
drop policy if exists "members raise proposals" on public.rule_proposals;
create policy "members raise proposals" on public.rule_proposals for insert to authenticated
  with check (proposer_id = auth.uid() and public.is_league_member(league_id));

-- Authors tidy up their own while it is still open; commissioners resolve any.
drop policy if exists "author or commissioner edits proposal" on public.rule_proposals;
create policy "author or commissioner edits proposal" on public.rule_proposals for update to authenticated
  using (
    (proposer_id = auth.uid() and status = 'open')
    or public.is_league_commissioner(league_id)
  )
  with check (
    (proposer_id = auth.uid() and status = 'open')
    or public.is_league_commissioner(league_id)
  );

drop policy if exists "author or commissioner deletes proposal" on public.rule_proposals;
create policy "author or commissioner deletes proposal" on public.rule_proposals for delete to authenticated
  using (
    (proposer_id = auth.uid() and status = 'open')
    or public.is_league_commissioner(league_id)
  );


-- ── Adopt ───────────────────────────────────────────────────────────────────
--  Writes the proposal into the rulebook and marks it adopted, in one
--  transaction. Done as two client calls, a failure between them either loses
--  the rule or leaves a proposal that claims to be adopted but is not in the
--  book.
create or replace function public.adopt_proposal(p_proposal uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_p    public.rule_proposals%rowtype;
  v_rule uuid;
begin
  select * into v_p from public.rule_proposals where id = p_proposal;
  if not found then raise exception 'Proposal not found'; end if;

  if not public.is_league_commissioner(v_p.league_id) then
    raise exception 'Only a commissioner can adopt a proposal';
  end if;
  if v_p.status <> 'open' then
    raise exception 'That proposal is already %', v_p.status;
  end if;

  insert into public.league_rules
    (league_id, proposer_id, title, description, category, effective_season, status)
  values
    (v_p.league_id, auth.uid(), v_p.title, v_p.description, v_p.category,
     v_p.target_season, 'passed')
  returning id into v_rule;

  update public.rule_proposals
     set status = 'adopted', resolved_by = auth.uid(), resolved_at = now()
   where id = p_proposal;

  insert into public.audit_log (league_id, actor_id, action, entity_type, entity_id, details)
  values (v_p.league_id, auth.uid(), 'rule.added', 'rule', v_rule,
          jsonb_build_object('title', v_p.title, 'category', v_p.category,
                             'from_proposal', true));

  return v_rule;
end;
$$;

grant execute on function public.adopt_proposal(uuid) to authenticated;
