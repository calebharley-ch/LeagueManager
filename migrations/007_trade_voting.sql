-- ============================================================================
--  007 - league vote on trades
--
--  Run after 006. Additive and idempotent.
--
--  New life of a trade:
--    pending    proposed, waiting on the other manager
--    accepted   both parties agreed - THE LEAGUE IS NOW VOTING
--    completed  reached the approval threshold (or commissioner forced it)
--    vetoed     reached the veto threshold (or commissioner vetoed it)
--    rejected   the receiving manager declined; never reaches a vote
--
--  The enum already had all five values, so no type change is needed - what
--  changes is that 'accepted' now means "open for league vote" rather than
--  "done pending the commissioner".
--
--  !! THRESHOLDS ARE ASYMMETRIC ON PURPOSE. 5 to approve, 9 to veto: a trade
--  the league is indifferent about should go through, and blocking one takes a
--  near-consensus. Both are per-league columns, not constants, so they can be
--  tuned without a deploy.
-- ============================================================================

alter table public.leagues
  add column if not exists trade_votes_to_approve integer not null default 5,
  add column if not exists trade_votes_to_veto    integer not null default 9;


-- ── trade_votes ─────────────────────────────────────────────────────────────
--  The UNIQUE constraint is what enforces one vote per manager per trade. The
--  RPC upserts onto it, so a manager can change their mind but never
--  double-count. A SELECT-then-INSERT would race two tabs into a duplicate.
create table if not exists public.trade_votes (
  id         uuid primary key default gen_random_uuid(),
  trade_id   uuid not null references public.trades(id) on delete cascade,
  voter_id   uuid not null references public.profiles(id) on delete cascade,
  approve    boolean not null,
  created_at timestamptz not null default now(),
  unique (trade_id, voter_id)
);
create index if not exists trade_votes_trade_idx on public.trade_votes (trade_id);

alter table public.trade_votes enable row level security;

drop policy if exists "trade votes readable" on public.trade_votes;
create policy "trade votes readable" on public.trade_votes for select to authenticated
  using (public.can_see_trade(trade_id));

-- Writes go through cast_trade_vote() only. No direct insert policy: the
-- threshold check and the status flip have to happen in the same transaction as
-- the vote, or two managers voting at once can both see 4 approvals and neither
-- will complete the trade.


-- ── Cast a vote ─────────────────────────────────────────────────────────────
create or replace function public.cast_trade_vote(p_trade uuid, p_approve boolean)
returns text language plpgsql security definer set search_path = public as $$
declare
  v_trade    public.trades%rowtype;
  v_approve  integer;
  v_veto     integer;
  v_need_ok  integer;
  v_need_no  integer;
  v_status   trade_status;
begin
  if auth.uid() is null then
    raise exception 'You must be signed in to vote';
  end if;

  select * into v_trade from public.trades where id = p_trade;
  if not found then raise exception 'Trade not found'; end if;

  if not public.is_league_member(v_trade.league_id) then
    raise exception 'You are not a member of this league';
  end if;

  -- Only while the league vote is open.
  if v_trade.status <> 'accepted' then
    raise exception 'This trade is not open for a league vote (it is %)', v_trade.status;
  end if;

  -- The two sides already agreed by proposing and accepting. Letting them vote
  -- again would let a trade approve itself.
  if auth.uid() = v_trade.proposer_id or auth.uid() = v_trade.receiver_id then
    raise exception 'You are part of this trade, so you do not vote on it';
  end if;

  insert into public.trade_votes (trade_id, voter_id, approve)
  values (p_trade, auth.uid(), p_approve)
  on conflict (trade_id, voter_id) do update set approve = excluded.approve;

  select count(*) filter (where approve),
         count(*) filter (where not approve)
    into v_approve, v_veto
    from public.trade_votes where trade_id = p_trade;

  select trade_votes_to_approve, trade_votes_to_veto
    into v_need_ok, v_need_no
    from public.leagues where id = v_trade.league_id;

  -- Veto checked first: if a trade somehow satisfies both, blocking wins.
  if v_veto >= v_need_no then
    v_status := 'vetoed';
  elsif v_approve >= v_need_ok then
    v_status := 'completed';
  else
    v_status := null;
  end if;

  if v_status is not null then
    update public.trades set status = v_status, resolved_by = auth.uid()
     where id = p_trade;

    insert into public.audit_log (league_id, actor_id, action, entity_type, entity_id, details)
    values (v_trade.league_id, auth.uid(),
            case when v_status = 'completed' then 'trade.completed' else 'trade.vetoed' end,
            'trade', p_trade,
            jsonb_build_object('by_league_vote', true,
                               'approvals', v_approve, 'vetoes', v_veto));
    return v_status::text;
  end if;

  return 'accepted';
end;
$$;

grant execute on function public.cast_trade_vote(uuid, boolean) to authenticated;
