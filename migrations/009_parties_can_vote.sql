-- ============================================================================
--  009 - the two managers in a trade can vote on it too
--
--  Run after 008. Replaces cast_trade_vote() in place; nothing else changes.
--
--  007 blocked the proposer and receiver from voting on the theory that they
--  had already agreed by proposing and accepting. The league wants everyone to
--  vote, so that check is gone.
--
--  !! WORTH KNOWING WHAT THIS DOES TO THE MATH. With 12 teams, both parties
--  can now vote and will almost always approve, so a trade effectively starts
--  2 of the way to the 5 it needs - only 3 neutral managers have to agree. The
--  veto threshold is untouched at 9. If that feels too easy, raise
--  leagues.trade_votes_to_approve; it is a column, not a constant.
-- ============================================================================

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

  if v_trade.status <> 'accepted' then
    raise exception 'This trade is not open for a league vote (it is %)', v_trade.status;
  end if;

  -- No party check: everyone in the league votes, including the two managers
  -- doing the trade.

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
