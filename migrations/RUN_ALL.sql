-- ============================================================================
--  RUN_ALL.sql - migrations 001 through 005, concatenated in order.
--
--  GENERATED FILE. Edit the numbered migrations, not this one.
--
--  Paste the whole thing into the Supabase SQL editor and run it once. Every
--  statement is additive and idempotent, so re-running is safe and will not
--  undo anything you have since changed in the app.
--
--  Pure ASCII on purpose. A non-ASCII character here only survives if every
--  tool in the chain agrees on the encoding, and on Windows they do not.
-- ============================================================================

-- ###########################################################################
-- 001_teams_faab_picks.sql
-- ###########################################################################
-- ============================================================================
--  001 - every ESPN team is a league team, FAAB, and pick ownership
--
--  Run this in the Supabase SQL editor. It is additive and idempotent: no drops,
--  no rewrites, safe to run twice. schema.sql carries the same changes for a
--  fresh install - this file exists because `create table if not exists` does
--  nothing to a table that already has rows.
--
--  WHY: league_members only ever held people who registered. With one member,
--  the trade dropdown had nobody in it. A "team" in this league is an ESPN team;
--  an account CLAIMS one. Unclaimed teams still show up, still get traded with.
-- ============================================================================

-- -- Trades against a team nobody has claimed yet ----------------------------
-- receiver_id becomes nullable and gains an ESPN-team alternative. Exactly one
-- of the two is set.
--
-- The existing update policy needs no change and that is deliberate:
--   using (receiver_id = auth.uid() or proposer_id = auth.uid() or commissioner)
-- With receiver_id null, `null = auth.uid()` evaluates to NULL, which RLS treats
-- as false - so an unclaimed team cannot accept its own trade, and the proposer
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


-- -- FAAB --------------------------------------------------------------------
-- Budget is a league setting; spend is per team. Both are overwritten by the
-- sync when ESPN reports them, so the defaults only matter until the first sync
-- (or for a league that does not use FAAB at all).
alter table public.leagues
  add column if not exists faab_budget integer not null default 100;

alter table public.espn_teams
  add column if not exists faab_spent integer;


-- -- Draft pick ownership ----------------------------------------------------
-- How many rounds a draft has. Needed to derive "which picks does this team
-- hold" - every team starts with one pick per round per year, and completed
-- trades move them. Kept in the database rather than hardcoded in the client so
-- the two cannot drift.
alter table public.leagues
  add column if not exists draft_rounds integer not null default 12;

-- ###########################################################################
-- 002_seed_coolclan_rules.sql
-- ###########################################################################
-- ============================================================================
--  002 - the three rules CoolClan already plays by
--
--  Run in the Supabase SQL editor AFTER 001. Idempotent: the `not exists` guard
--  means running it twice does not duplicate anything, and editing a rule in the
--  app afterwards will not be undone by a re-run.
--
--  By default this targets the OLDEST league in the table, which is correct if
--  you only have one. If you have more than one, uncomment the `where` line.
-- ============================================================================

with target as (
  select l.id, l.commissioner_id
  from public.leagues l
  -- where l.name = 'CoolClan'          -- <- uncomment and set if you have several
  order by l.created_at
  limit 1
)
insert into public.league_rules
  (league_id, proposer_id, title, description, category, effective_season, status)
select
  t.id,
  t.commissioner_id,
  r.title,
  r.description,
  r.category::rule_category,
  2026,
  'passed'::rule_status
from target t
cross join (values
  -- !! ONE E'' LITERAL PER VALUE, ASCII ONLY.
  -- Adjacent E'' literals are NOT concatenated the way plain string constants
  -- are; Postgres raises a syntax error at the second one. And a non-ASCII
  -- bullet survives a UTF-8 round trip only if every tool in the chain agrees
  -- on the encoding, which on Windows they do not.
  (
    'Keeper rules',
    E'- A player cannot be kept two years in a row.\n- A first-round draft pick cannot be kept.\n- A free agent counts as a 9th-round pick.\n- If a player is traded, he still counts at his original draft position.\n- If a player is ever dropped, he always counts toward the round he was originally drafted in.',
    'Draft'
  ),
  (
    'In-person draft',
    'The CoolClan draft is held in person every other year. Agreed by the league.',
    'Governance'
  ),
  (
    'Last-place punishment',
    'The last-place finisher gives a 30-minute presentation about everyone''s lives, delivered before the draft.',
    'Governance'
  )
) as r(title, description, category)
where not exists (
  select 1 from public.league_rules existing
  where existing.league_id = t.id and existing.title = r.title
);

-- ###########################################################################
-- 003_seed_pick_trading_rule.sql
-- ###########################################################################
-- ============================================================================
--  003 - draft pick trading rule
--
--  Run after 002. Same idempotent guard: safe to re-run, and it will not
--  overwrite the rule if you have since edited it in the app.
--
--  !! This rule is ALSO enforced in code, and the two must agree:
--    src/lib/constants.js -> PICK_YEARS          (only next year's picks)
--    src/lib/constants.js -> MAX_OWN_PICKS_TRADED (three)
--  Change the rule text here and you must change those constants too, or the
--  rulebook will say one thing and the trade builder will do another.
-- ============================================================================

with target as (
  select l.id, l.commissioner_id
  from public.leagues l
  -- where l.name = 'CoolClan'          -- <- uncomment and set if you have several
  order by l.created_at
  limit 1
)
insert into public.league_rules
  (league_id, proposer_id, title, description, category, effective_season, status)
select
  t.id,
  t.commissioner_id,
  r.title,
  r.description,
  r.category::rule_category,
  2026,
  'passed'::rule_status
from target t
cross join (values
  -- One E'' literal, ASCII only. See the note in 002 for why.
  (
    'Draft pick trading',
    E'- Only next year''s draft picks may be traded. Picks two or more drafts out are not tradeable.\n- A team may trade away at most three of its own picks.\n- Picks acquired from another team do not count against that limit; the cap is on selling your own draft.\n- A pick counts as committed as soon as the trade is proposed, not when it is completed.',
    'Draft'
  )
) as r(title, description, category)
where not exists (
  select 1 from public.league_rules existing
  where existing.league_id = t.id and existing.title = r.title
);

-- ###########################################################################
-- 004_email_notifications.sql
-- ###########################################################################
-- ============================================================================
--  004 - per-manager email opt-out
--
--  Run after 003. Additive and idempotent.
--
--  Default TRUE: a trade sitting unanswered because nobody knew about it is the
--  problem this feature exists to solve, so notifications are on unless someone
--  turns them off. The toggle lives on the MEMBERSHIP, not the profile - you
--  might want mail from one league and not another.
-- ============================================================================

alter table public.league_members
  add column if not exists email_notifications boolean not null default true;

-- ###########################################################################
-- 005_league_invites.sql
-- ###########################################################################
-- ============================================================================
--  005 - invite addresses for teams that have not registered
--
--  Run after 004. Additive and idempotent.
--
--  Its own table rather than a column on espn_teams, for two reasons:
--    1. espn_teams is upserted by every sync. A column there is one careless
--       payload change away from being wiped.
--    2. These are other people's personal email addresses. They deserve their
--       own RLS boundary, not whatever espn_teams happens to allow.
--
--  !! COMMISSIONER-ONLY, INCLUDING SELECT. Managers can see who has registered;
--  they have no business reading the league's address book.
-- ============================================================================

create table if not exists public.league_invites (
  league_id    uuid not null references public.leagues(id) on delete cascade,
  espn_team_id integer not null,
  email        text not null,
  invited_at   timestamptz,          -- null until the first send succeeds
  invited_by   uuid references public.profiles(id) on delete set null,
  send_count   integer not null default 0,
  updated_at   timestamptz not null default now(),
  primary key (league_id, espn_team_id)
);

alter table public.league_invites enable row level security;

drop policy if exists "commissioner reads invites" on public.league_invites;
create policy "commissioner reads invites" on public.league_invites for select to authenticated
  using (public.is_league_commissioner(league_id));

drop policy if exists "commissioner adds invites" on public.league_invites;
create policy "commissioner adds invites" on public.league_invites for insert to authenticated
  with check (public.is_league_commissioner(league_id));

drop policy if exists "commissioner edits invites" on public.league_invites;
create policy "commissioner edits invites" on public.league_invites for update to authenticated
  using (public.is_league_commissioner(league_id))
  with check (public.is_league_commissioner(league_id));

drop policy if exists "commissioner removes invites" on public.league_invites;
create policy "commissioner removes invites" on public.league_invites for delete to authenticated
  using (public.is_league_commissioner(league_id));
