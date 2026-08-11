-- ============================================================================
--  001 — every ESPN team is a league team, FAAB, and pick ownership
--
--  Run this in the Supabase SQL editor. It is additive and idempotent: no drops,
--  no rewrites, safe to run twice. schema.sql carries the same changes for a
--  fresh install — this file exists because `create table if not exists` does
--  nothing to a table that already has rows.
--
--  WHY: league_members only ever held people who registered. With one member,
--  the trade dropdown had nobody in it. A "team" in this league is an ESPN team;
--  an account CLAIMS one. Unclaimed teams still show up, still get traded with.
-- ============================================================================

-- ── Trades against a team nobody has claimed yet ────────────────────────────
-- receiver_id becomes nullable and gains an ESPN-team alternative. Exactly one
-- of the two is set.
--
-- The existing update policy needs no change and that is deliberate:
--   using (receiver_id = auth.uid() or proposer_id = auth.uid() or commissioner)
-- With receiver_id null, `null = auth.uid()` evaluates to NULL, which RLS treats
-- as false — so an unclaimed team cannot accept its own trade, and the proposer
-- or the commissioner settles it. That is the behaviour we want.
alter table public.trades alter column receiver_id drop not null;
alter table public.trades add column if not exists receiver_espn_team_id integer;

alter table public.trades drop constraint if exists trades_receiver_one_of;
alter table public.trades add constraint trades_receiver_one_of check (
  (receiver_id is not null and receiver_espn_team_id is null) or
  (receiver_id is null     and receiver_espn_team_id is not null)
);

create index if not exists trades_receiver_espn_idx
  on public.trades (league_id, receiver_espn_team_id);

-- A traded pick can originate from an unclaimed team too.
alter table public.trade_items
  add column if not exists pick_original_espn_team_id integer;


-- ── FAAB ────────────────────────────────────────────────────────────────────
-- Budget is a league setting; spend is per team. Both are overwritten by the
-- sync when ESPN reports them, so the defaults only matter until the first sync
-- (or for a league that does not use FAAB at all).
alter table public.leagues
  add column if not exists faab_budget integer not null default 100;

alter table public.espn_teams
  add column if not exists faab_spent integer;


-- ── Draft pick ownership ────────────────────────────────────────────────────
-- How many rounds a draft has. Needed to derive "which picks does this team
-- hold" — every team starts with one pick per round per year, and completed
-- trades move them. Kept in the database rather than hardcoded in the client so
-- the two cannot drift.
alter table public.leagues
  add column if not exists draft_rounds integer not null default 12;
