-- ============================================================================
--  015 - fixes to the proposals feature from code review
--
--  Run after 014. Additive and idempotent.
--
--  Five defects, one of them a cross-league write.
-- ============================================================================

-- ── 1. Cross-league write ───────────────────────────────────────────────────
--  !! THE HOLE: the author branch of the UPDATE policy constrained WHO and
--  WHAT STATUS, but never WHICH LEAGUE. So an author could
--
--    update rule_proposals set league_id = '<some other league>' where id = ...
--
--  and both `using` (old row) and `with check` (new row) passed, because
--  league_id is not mentioned in either. The row then sat on a league they are
--  not a member of, readable by all of that league via is_league_member.
--
--  The INSERT policy already had this constraint; the UPDATE policy is the only
--  one in the schema that was missing it.
drop policy if exists "author or commissioner edits proposal" on public.rule_proposals;
create policy "author or commissioner edits proposal" on public.rule_proposals for update to authenticated
  using (
    public.is_league_member(league_id)
    and (
      (proposer_id = auth.uid() and status = 'open')
      or public.is_league_commissioner(league_id)
    )
  )
  with check (
    public.is_league_member(league_id)
    and (
      (proposer_id = auth.uid() and status = 'open')
      or public.is_league_commissioner(league_id)
    )
  );


-- ── 2. Client-side adoption bypassing the RPC ───────────────────────────────
--  adopt_proposal exists so a proposal marked 'adopted' is always accompanied
--  by a real rule, in one transaction. But the UPDATE policy still let a
--  commissioner set status directly from the browser, producing exactly the
--  state the RPC was written to prevent: adopted, but not in the book.
--
--  RLS cannot compare OLD to NEW, so this needs a trigger. SECURITY DEFINER
--  functions run with the definer's rights and are not blocked by it; the
--  session variable is how adopt_proposal identifies itself.
create or replace function public.guard_proposal_adoption()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'adopted' and old.status is distinct from 'adopted' then
    if current_setting('app.adopting_proposal', true) is distinct from 'on' then
      raise exception
        'Use adopt_proposal() to adopt - it writes the rule and marks the proposal in one transaction';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists rule_proposals_guard_adoption on public.rule_proposals;
create trigger rule_proposals_guard_adoption
  before update on public.rule_proposals
  for each row execute function public.guard_proposal_adoption();


-- ── 3 + 4. Concurrent adopts, and crediting the wrong author ────────────────
--  3: two commissioners clicking Adopt at the same moment both read status =
--     'open' under READ COMMITTED, both pass the check, and both insert a rule.
--     `for update` makes the second wait, then find it already adopted.
--
--  4: the rule was written with proposer_id = auth.uid(), so the rulebook said
--     the ADOPTING COMMISSIONER wrote it. The whole point of the proposals
--     table is recording whose idea it was; that was lost at the moment it
--     became a rule. The function is SECURITY DEFINER, so it can attribute the
--     rule to the original proposer without tripping the insert policy.
create or replace function public.adopt_proposal(p_proposal uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_p    public.rule_proposals%rowtype;
  v_rule uuid;
begin
  -- Lock first, so a second caller blocks here rather than racing the check.
  select * into v_p from public.rule_proposals where id = p_proposal for update;
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
    (v_p.league_id,
     coalesce(v_p.proposer_id, auth.uid()),   -- whose idea it was, not who adopted it
     v_p.title, v_p.description, v_p.category, v_p.target_season, 'passed')
  returning id into v_rule;

  perform set_config('app.adopting_proposal', 'on', true);  -- true = this txn only
  update public.rule_proposals
     set status = 'adopted', resolved_by = auth.uid(), resolved_at = now()
   where id = p_proposal;
  perform set_config('app.adopting_proposal', 'off', true);

  insert into public.audit_log (league_id, actor_id, action, entity_type, entity_id, details)
  values (v_p.league_id, auth.uid(), 'rule.added', 'rule', v_rule,
          jsonb_build_object('title', v_p.title, 'category', v_p.category,
                             'from_proposal', true));

  return v_rule;
end;
$$;

grant execute on function public.adopt_proposal(uuid) to authenticated;


-- ── 5. Losing the trail when a manager leaves ───────────────────────────────
--  proposer_id cascaded, so deleting a departed manager's account deleted every
--  proposal they ever raised - including adopted ones, which the header of 014
--  says are kept "for the trail". resolved_by on the same table already used
--  set null; this makes proposer_id match.
alter table public.rule_proposals
  alter column proposer_id drop not null;

alter table public.rule_proposals
  drop constraint if exists rule_proposals_proposer_id_fkey;

alter table public.rule_proposals
  add constraint rule_proposals_proposer_id_fkey
  foreign key (proposer_id) references public.profiles(id) on delete set null;


-- ── 6. Index that could not serve its query ─────────────────────────────────
--  The only query is `where league_id = ? order by created_at desc`, with no
--  status predicate. With status between the equality column and the sort
--  column, Postgres cannot use the index for the ordering. Status is filtered
--  in memory by the component anyway.
drop index if exists public.rule_proposals_league_idx;
create index if not exists rule_proposals_league_created_idx
  on public.rule_proposals (league_id, created_at desc);
