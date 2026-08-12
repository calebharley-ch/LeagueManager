-- ============================================================================
--  010 - proposing and accepting count as approving
--
--  Run after 009.
--
--  Offering a trade IS voting for it, and so is accepting one. Making both
--  managers click Approve on a deal they just agreed to is busywork, and it
--  left the count showing 0 approvals on a trade two people had already
--  committed to.
--
--  Recorded as ordinary rows in trade_votes, so:
--    - the count and the bars are honest with no special-casing
--    - either manager can still change their mind by clicking Veto, which is
--      the whole reason this is a vote rather than a flag
--
--  !! DOES NOT EVALUATE THRESHOLDS. Only cast_trade_vote() completes or vetoes
--  a trade. A trade cannot pass at the moment it is proposed, which is correct:
--  the league has not seen it yet. With the defaults it opens at 2 of 5.
-- ============================================================================

create or replace function public.record_proposer_vote()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.trade_votes (trade_id, voter_id, approve)
  values (new.id, new.proposer_id, true)
  on conflict (trade_id, voter_id) do nothing;
  return new;
end;
$$;

drop trigger if exists trades_record_proposer_vote on public.trades;
create trigger trades_record_proposer_vote
  after insert on public.trades
  for each row execute function public.record_proposer_vote();


create or replace function public.record_receiver_vote()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  -- Only when the trade actually moves into the league vote, and only for a
  -- receiver who has an account. An unclaimed ESPN team has nobody to vote.
  if new.status = 'accepted' and old.status is distinct from 'accepted'
     and new.receiver_id is not null then
    insert into public.trade_votes (trade_id, voter_id, approve)
    values (new.id, new.receiver_id, true)
    on conflict (trade_id, voter_id) do nothing;
  end if;
  return new;
end;
$$;

drop trigger if exists trades_record_receiver_vote on public.trades;
create trigger trades_record_receiver_vote
  after update on public.trades
  for each row execute function public.record_receiver_vote();


-- Backfill trades already waiting on a league vote, so they are not stuck
-- showing fewer approvals than they actually have.
insert into public.trade_votes (trade_id, voter_id, approve)
select t.id, t.proposer_id, true from public.trades t
where t.status in ('pending', 'accepted')
on conflict (trade_id, voter_id) do nothing;

insert into public.trade_votes (trade_id, voter_id, approve)
select t.id, t.receiver_id, true from public.trades t
where t.status = 'accepted' and t.receiver_id is not null
on conflict (trade_id, voter_id) do nothing;
