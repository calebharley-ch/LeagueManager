-- ============================================================================
--  011 - mark a completed trade as applied in ESPN
--
--  Run after 010. Additive and idempotent.
--
--  ESPN enforces waiver bids against ITS OWN budget number. A FAAB trade that
--  has not been applied in ESPN is not actually binding - the manager can still
--  bid money they traded away, and ESPN will honour it. So the commissioner has
--  to make the adjustment there, which makes ESPN the enforcing system of
--  record and this app the ledger that tracks whether it has happened yet.
--
--  Two jobs for one timestamp:
--
--  1. STOPS THE DOUBLE COUNT. Before settlement the app shows ESPN's spend plus
--     the traded delta. Once ESPN has been adjusted, its own figure already
--     includes the transfer, so deriveFaab() must stop adding it. Without this
--     flag the two would compound every sync.
--
--  2. IS THE COMMISSIONER'S WORKLIST. Players and picks also need applying by
--     hand, and they have the same failure mode: a trade completes on a Tuesday
--     and nobody touches ESPN until someone overspends in week 9. The
--     arithmetic was never the hard part; remembering was.
-- ============================================================================

alter table public.trades
  add column if not exists espn_settled_at timestamptz,
  add column if not exists espn_settled_by uuid references public.profiles(id) on delete set null;

create index if not exists trades_unsettled_idx
  on public.trades (league_id, status)
  where espn_settled_at is null;


-- !! COMMISSIONER ONLY, ENFORCED IN THE DATABASE.
-- The trades update policy deliberately lets either party resolve a trade, so
-- without this a manager could mark their own trade applied and quietly erase
-- their own FAAB delta. RLS cannot compare OLD to NEW, so it needs a trigger -
-- same pattern as the role guard in 008.
create or replace function public.guard_espn_settlement()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.espn_settled_at is distinct from old.espn_settled_at then
    if not public.is_league_commissioner(old.league_id) then
      raise exception 'Only a commissioner can mark a trade applied in ESPN';
    end if;
    if new.espn_settled_at is not null and new.status <> 'completed' then
      raise exception 'Only a completed trade can be marked applied in ESPN';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trades_guard_espn_settlement on public.trades;
create trigger trades_guard_espn_settlement
  before update on public.trades
  for each row execute function public.guard_espn_settlement();
