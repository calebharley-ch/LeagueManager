-- ============================================================================
--  League Manager — schema, RLS, triggers
--  Paste into Supabase → SQL Editor → Run. Idempotent; safe to re-run.
--
--  ⚠️ THIS REPLACES THE EARLIER SINGLE-LEAGUE SCHEMA. If you already ran that
--     one and have data, this will NOT migrate it — trades and rules had no
--     league_id to migrate to. Drop the old tables first, or start clean.
--
--  Shape: a user has ONE profile and can belong to MANY leagues. Everything a
--  league owns is scoped by league_id, and team_name lives on the MEMBERSHIP,
--  not the profile — you can be "Gridiron Goblins" in one league and something
--  else in another.
-- ============================================================================

-- ── Enums ───────────────────────────────────────────────────────────────────
do $$ begin create type league_role   as enum ('manager', 'commissioner');
exception when duplicate_object then null; end $$;

do $$ begin create type trade_status  as enum ('pending','accepted','rejected','vetoed','completed');
exception when duplicate_object then null; end $$;

do $$ begin create type trade_side    as enum ('A', 'B');
exception when duplicate_object then null; end $$;

do $$ begin create type asset_type    as enum ('player', 'faab', 'pick');
exception when duplicate_object then null; end $$;

do $$ begin create type rule_category as enum ('Scoring','Roster','Draft','Financial','Governance');
exception when duplicate_object then null; end $$;

do $$ begin create type rule_status   as enum ('proposed', 'passed', 'rejected');
exception when duplicate_object then null; end $$;


-- ── profiles ────────────────────────────────────────────────────────────────
-- Global identity only. No team name, no role — both are per-league.
create table if not exists public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  created_at   timestamptz not null default now()
);


-- ── leagues ─────────────────────────────────────────────────────────────────
create table if not exists public.leagues (
  id               uuid primary key default gen_random_uuid(),
  name             text not null,
  commissioner_id  uuid not null references public.profiles(id) on delete restrict,
  espn_league_id   text,
  season           integer not null default extract(year from now())::int,
  invite_code      text not null unique,
  -- Mirrored status so the UI can show "ESPN connected" WITHOUT ever reading
  -- the credentials. Maintained by the trigger below and the Edge Function.
  espn_connected   boolean not null default false,
  last_sync_at     timestamptz,
  last_sync_status text,
  -- Overwritten by the sync when ESPN reports them. The defaults only matter
  -- before the first sync, or for a league that does not use FAAB.
  faab_budget      integer not null default 100,
  draft_rounds     integer not null default 12,
  created_at       timestamptz not null default now()
);


-- ── league_members ──────────────────────────────────────────────────────────
create table if not exists public.league_members (
  id           uuid primary key default gen_random_uuid(),
  league_id    uuid not null references public.leagues(id) on delete cascade,
  profile_id   uuid not null references public.profiles(id) on delete cascade,
  team_name    text not null,
  role         league_role not null default 'manager',
  espn_team_id integer,        -- links this member to their ESPN fantasy team
  -- Per-league, not per-account: mail from one league, silence from another.
  email_notifications boolean not null default true,
  joined_at    timestamptz not null default now(),
  unique (league_id, profile_id)
);
create index if not exists league_members_profile_idx on public.league_members (profile_id);
create index if not exists league_members_league_idx  on public.league_members (league_id);


-- ── ESPN credentials — WRITE-ONLY FROM THE CLIENT ───────────────────────────
-- ⚠️ THERE IS DELIBERATELY NO SELECT POLICY ON THIS TABLE.
-- Not for managers, not for the commissioner, not for the person who typed
-- them in. Nobody reads these back through the API. Only the sync-espn Edge
-- Function can, using the service_role key, and it runs on Supabase's servers.
--
-- These are session cookies for a real ESPN account, not scoped tokens. If they
-- were readable by the client they would end up in the browser — which is the
-- exact thing this design exists to prevent.
create table if not exists public.league_espn_credentials (
  league_id  uuid primary key references public.leagues(id) on delete cascade,
  espn_s2    text not null,
  swid       text not null,
  updated_by uuid references public.profiles(id) on delete set null,
  updated_at timestamptz not null default now()
);


-- ── trades ──────────────────────────────────────────────────────────────────
create table if not exists public.trades (
  id           uuid primary key default gen_random_uuid(),
  league_id    uuid not null references public.leagues(id) on delete cascade,
  proposer_id  uuid not null references public.profiles(id) on delete cascade,
  -- The receiver is EITHER a registered account or an ESPN team nobody has
  -- claimed yet. A 12-team league rarely has 12 signups on day one, and the
  -- commissioner still needs to record trades against those teams.
  receiver_id  uuid references public.profiles(id) on delete cascade,
  receiver_espn_team_id integer,
  status       trade_status not null default 'pending',
  rationale    text,
  created_at   timestamptz not null default now(),
  resolved_at  timestamptz,
  resolved_by  uuid references public.profiles(id) on delete set null,
  constraint trades_distinct_parties check (proposer_id <> receiver_id),
  constraint trades_receiver_one_of check (
    (receiver_id is not null and receiver_espn_team_id is null) or
    (receiver_id is null     and receiver_espn_team_id is not null)
  )
);
create index if not exists trades_league_status_idx on public.trades (league_id, status);
create index if not exists trades_receiver_idx      on public.trades (receiver_id, status);
create index if not exists trades_receiver_espn_idx on public.trades (league_id, receiver_espn_team_id);


-- ── trade_items ─────────────────────────────────────────────────────────────
-- side 'A' = what the PROPOSER gives up, 'B' = what the RECEIVER gives up.
create table if not exists public.trade_items (
  id                     uuid primary key default gen_random_uuid(),
  trade_id               uuid not null references public.trades(id) on delete cascade,
  side                   trade_side not null,
  item_type              asset_type not null,
  player_name            text,
  player_position        text,
  espn_player_id         integer,     -- nullable: you can trade a player ESPN never heard of
  faab_amount            integer,
  pick_year              integer,
  pick_round             integer,
  pick_original_owner_id uuid references public.profiles(id) on delete set null,
  -- Same reason as trades.receiver_espn_team_id: the team a pick originally
  -- belonged to may not have an account.
  pick_original_espn_team_id integer,
  created_at             timestamptz not null default now(),
  constraint trade_items_shape check (
    (item_type = 'player' and player_name is not null and length(trim(player_name)) > 0)
    or (item_type = 'faab' and faab_amount is not null and faab_amount > 0)
    or (item_type = 'pick' and pick_year is not null and pick_round between 1 and 12)
  )
);
create index if not exists trade_items_trade_idx on public.trade_items (trade_id);


-- ── league_rules ────────────────────────────────────────────────────────────
create table if not exists public.league_rules (
  id               uuid primary key default gen_random_uuid(),
  league_id        uuid not null references public.leagues(id) on delete cascade,
  proposer_id      uuid not null references public.profiles(id) on delete cascade,
  title            text not null,
  description      text,
  category         rule_category not null,
  effective_season integer not null,
  status           rule_status not null default 'proposed',
  created_at       timestamptz not null default now(),
  resolved_at      timestamptz,
  resolved_by      uuid references public.profiles(id) on delete set null
);
create index if not exists league_rules_league_status_idx on public.league_rules (league_id, status);


-- ── rule_votes ──────────────────────────────────────────────────────────────
-- The UNIQUE constraint is what enforces one vote per user per rule. The app
-- upserts onto it, so a manager can change their mind but never double-vote.
create table if not exists public.rule_votes (
  id         uuid primary key default gen_random_uuid(),
  rule_id    uuid not null references public.league_rules(id) on delete cascade,
  voter_id   uuid not null references public.profiles(id) on delete cascade,
  vote       boolean not null,
  created_at timestamptz not null default now(),
  unique (rule_id, voter_id)
);


-- ── audit_log ───────────────────────────────────────────────────────────────
create table if not exists public.audit_log (
  id          uuid primary key default gen_random_uuid(),
  league_id   uuid not null references public.leagues(id) on delete cascade,
  actor_id    uuid references public.profiles(id) on delete set null,
  action      text not null,
  entity_type text,
  entity_id   uuid,
  details     jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);
create index if not exists audit_log_league_created_idx on public.audit_log (league_id, created_at desc);


-- ── ESPN data, scoped per league ────────────────────────────────────────────
create table if not exists public.espn_players (
  league_id     uuid not null references public.leagues(id) on delete cascade,
  espn_id       integer not null,
  season        integer not null,
  name          text not null,
  position      text,
  pro_team      text,
  injury_status text,
  espn_rank     integer,
  adp           numeric,
  pct_owned     numeric,
  auction_value numeric,
  updated_at    timestamptz not null default now(),
  primary key (league_id, espn_id, season)
);
create index if not exists espn_players_lookup_idx on public.espn_players (league_id, season, espn_rank);

create table if not exists public.espn_teams (
  league_id        uuid not null references public.leagues(id) on delete cascade,
  espn_team_id     integer not null,
  season           integer not null,
  team_name        text,
  owner_name       text,
  wins             integer,
  losses           integer,
  faab_spent       integer,
  updated_at       timestamptz not null default now(),
  primary key (league_id, espn_team_id, season)
);

create table if not exists public.espn_rosters (
  id             bigint generated always as identity primary key,
  league_id      uuid not null references public.leagues(id) on delete cascade,
  season         integer not null,
  espn_team_id   integer not null,
  espn_player_id integer not null,
  lineup_slot    text,
  acquired_type  text,
  updated_at     timestamptz not null default now(),
  unique (league_id, season, espn_team_id, espn_player_id)
);
create index if not exists espn_rosters_lookup_idx on public.espn_rosters (league_id, season, espn_team_id);


-- ============================================================================
--  Helper functions
--
--  SECURITY DEFINER with a pinned search_path so they can read league_members
--  without recursing through its own RLS policy — that recursion is the classic
--  "infinite recursion detected in policy" error.
-- ============================================================================
create or replace function public.is_league_member(p_league uuid)
returns boolean language sql security definer set search_path = public stable as $$
  select exists (
    select 1 from public.league_members
    where league_id = p_league and profile_id = auth.uid()
  );
$$;

create or replace function public.is_league_commissioner(p_league uuid)
returns boolean language sql security definer set search_path = public stable as $$
  select exists (
    select 1 from public.league_members
    where league_id = p_league and profile_id = auth.uid() and role = 'commissioner'
  );
$$;

-- Trade helpers, so trade_items policies don't repeat the join.
create or replace function public.can_see_trade(p_trade uuid)
returns boolean language sql security definer set search_path = public stable as $$
  select exists (
    select 1 from public.trades t
    where t.id = p_trade and public.is_league_member(t.league_id)
  );
$$;

create or replace function public.owns_pending_trade(p_trade uuid)
returns boolean language sql security definer set search_path = public stable as $$
  select exists (
    select 1 from public.trades t
    where t.id = p_trade and t.proposer_id = auth.uid() and t.status = 'pending'
  );
$$;

create or replace function public.can_see_rule(p_rule uuid)
returns boolean language sql security definer set search_path = public stable as $$
  select exists (
    select 1 from public.league_rules r
    where r.id = p_rule and public.is_league_member(r.league_id)
  );
$$;


-- ============================================================================
--  Create / join
-- ============================================================================

-- Readable, unambiguous invite codes. No 0/O/1/I/L — people read these aloud.
create or replace function public.generate_invite_code()
returns text language plpgsql as $$
declare
  alphabet text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  code text;
  i int;
begin
  loop
    code := '';
    for i in 1..8 loop
      code := code || substr(alphabet, floor(random() * length(alphabet) + 1)::int, 1);
    end loop;
    exit when not exists (select 1 from public.leagues where invite_code = code);
  end loop;
  return code;
end;
$$;

-- Creating a league and becoming its commissioner must be ONE atomic step.
-- Done as two client calls, a failure between them leaves an orphan league with
-- no members — invisible to its own creator, because every SELECT policy below
-- requires membership.
create or replace function public.create_league(p_name text, p_team_name text,
                                                p_espn_league_id text default null,
                                                p_season integer default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_league uuid;
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  if coalesce(trim(p_name), '') = '' then raise exception 'League name is required'; end if;
  if coalesce(trim(p_team_name), '') = '' then raise exception 'Team name is required'; end if;

  insert into public.leagues (name, commissioner_id, espn_league_id, season, invite_code)
  values (trim(p_name), auth.uid(), nullif(trim(coalesce(p_espn_league_id, '')), ''),
          coalesce(p_season, extract(year from now())::int), public.generate_invite_code())
  returning id into v_league;

  insert into public.league_members (league_id, profile_id, team_name, role)
  values (v_league, auth.uid(), trim(p_team_name), 'commissioner');

  insert into public.audit_log (league_id, actor_id, action, entity_type, entity_id, details)
  values (v_league, auth.uid(), 'league.created', 'league', v_league,
          jsonb_build_object('name', trim(p_name)));

  return v_league;
end;
$$;

-- Joining by code. SECURITY DEFINER because a non-member cannot SELECT the
-- league to find it — that is the point of the RLS below, and this function is
-- the only door through it.
create or replace function public.join_league(p_code text, p_team_name text)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_league uuid;
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  if coalesce(trim(p_team_name), '') = '' then raise exception 'Team name is required'; end if;

  select id into v_league from public.leagues
  where upper(invite_code) = upper(trim(p_code));

  if v_league is null then raise exception 'No league found with that invite code'; end if;

  if exists (select 1 from public.league_members
             where league_id = v_league and profile_id = auth.uid()) then
    return v_league;                       -- already a member; idempotent
  end if;

  insert into public.league_members (league_id, profile_id, team_name, role)
  values (v_league, auth.uid(), trim(p_team_name), 'manager');

  insert into public.audit_log (league_id, actor_id, action, entity_type, entity_id, details)
  values (v_league, auth.uid(), 'league.joined', 'league', v_league,
          jsonb_build_object('team_name', trim(p_team_name)));

  return v_league;
end;
$$;

create or replace function public.rotate_invite_code(p_league uuid)
returns text language plpgsql security definer set search_path = public as $$
declare v_code text;
begin
  if not public.is_league_commissioner(p_league) then
    raise exception 'Only the commissioner can rotate the invite code';
  end if;
  v_code := public.generate_invite_code();
  update public.leagues set invite_code = v_code where id = p_league;
  return v_code;
end;
$$;

-- Store ESPN credentials. A FUNCTION rather than a direct insert so the client
-- never needs any privilege on that table beyond calling this, and so the
-- espn_connected flag can never drift from whether a row actually exists.
create or replace function public.set_espn_credentials(p_league uuid, p_s2 text, p_swid text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_league_commissioner(p_league) then
    raise exception 'Only the commissioner can connect ESPN';
  end if;
  if coalesce(trim(p_s2), '') = '' or coalesce(trim(p_swid), '') = '' then
    raise exception 'Both ESPN_S2 and SWID are required';
  end if;

  insert into public.league_espn_credentials (league_id, espn_s2, swid, updated_by, updated_at)
  values (p_league, trim(p_s2), trim(p_swid), auth.uid(), now())
  on conflict (league_id) do update
    set espn_s2 = excluded.espn_s2, swid = excluded.swid,
        updated_by = excluded.updated_by, updated_at = now();

  update public.leagues set espn_connected = true where id = p_league;

  insert into public.audit_log (league_id, actor_id, action, entity_type, entity_id, details)
  values (p_league, auth.uid(), 'league.espn_connected', 'league', p_league, '{}'::jsonb);
end;
$$;

create or replace function public.clear_espn_credentials(p_league uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_league_commissioner(p_league) then
    raise exception 'Only the commissioner can disconnect ESPN';
  end if;
  delete from public.league_espn_credentials where league_id = p_league;
  update public.leagues set espn_connected = false where id = p_league;
end;
$$;


-- ============================================================================
--  Row Level Security
--  Members read everything in THEIR leagues and nothing in anyone else's.
-- ============================================================================
alter table public.profiles                enable row level security;
alter table public.leagues                 enable row level security;
alter table public.league_members          enable row level security;
alter table public.league_espn_credentials enable row level security;
alter table public.trades                  enable row level security;
alter table public.trade_items             enable row level security;
alter table public.league_rules            enable row level security;
alter table public.rule_votes              enable row level security;
alter table public.audit_log               enable row level security;
alter table public.espn_players            enable row level security;
alter table public.espn_teams              enable row level security;
alter table public.espn_rosters            enable row level security;

-- profiles: readable by anyone authenticated (you need names of people you
-- share a league with; a profile holds nothing sensitive).
drop policy if exists "profiles readable" on public.profiles;
create policy "profiles readable" on public.profiles for select to authenticated using (true);

drop policy if exists "own profile writable" on public.profiles;
create policy "own profile writable" on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

drop policy if exists "own profile insertable" on public.profiles;
create policy "own profile insertable" on public.profiles for insert to authenticated
  with check (id = auth.uid());

-- leagues: only members. Creation goes through create_league().
drop policy if exists "leagues readable by members" on public.leagues;
create policy "leagues readable by members" on public.leagues for select to authenticated
  using (public.is_league_member(id));

drop policy if exists "commissioner updates league" on public.leagues;
create policy "commissioner updates league" on public.leagues for update to authenticated
  using (public.is_league_commissioner(id)) with check (public.is_league_commissioner(id));

-- league_members
drop policy if exists "members readable by league" on public.league_members;
create policy "members readable by league" on public.league_members for select to authenticated
  using (public.is_league_member(league_id));

drop policy if exists "own membership updatable" on public.league_members;
create policy "own membership updatable" on public.league_members for update to authenticated
  using (profile_id = auth.uid() or public.is_league_commissioner(league_id))
  with check (profile_id = auth.uid() or public.is_league_commissioner(league_id));

drop policy if exists "commissioner removes members" on public.league_members;
create policy "commissioner removes members" on public.league_members for delete to authenticated
  using (public.is_league_commissioner(league_id) and profile_id <> auth.uid());

-- league_espn_credentials:
--   ⚠️ NO SELECT POLICY, ON PURPOSE. Writes go through set_espn_credentials().
--   Do not add a select policy "so the UI can show them" — the UI shows the
--   espn_connected flag on leagues instead, which is exactly enough.

-- trades
drop policy if exists "trades readable by league" on public.trades;
create policy "trades readable by league" on public.trades for select to authenticated
  using (public.is_league_member(league_id));

drop policy if exists "propose trades in my league" on public.trades;
create policy "propose trades in my league" on public.trades for insert to authenticated
  with check (proposer_id = auth.uid() and public.is_league_member(league_id));

drop policy if exists "resolve trades i am party to" on public.trades;
create policy "resolve trades i am party to" on public.trades for update to authenticated
  using (receiver_id = auth.uid() or proposer_id = auth.uid() or public.is_league_commissioner(league_id))
  with check (receiver_id = auth.uid() or proposer_id = auth.uid() or public.is_league_commissioner(league_id));

drop policy if exists "commissioner deletes trades" on public.trades;
create policy "commissioner deletes trades" on public.trades for delete to authenticated
  using (public.is_league_commissioner(league_id));

-- trade_items
drop policy if exists "trade items readable" on public.trade_items;
create policy "trade items readable" on public.trade_items for select to authenticated
  using (public.can_see_trade(trade_id));

drop policy if exists "attach items to own pending trade" on public.trade_items;
create policy "attach items to own pending trade" on public.trade_items for insert to authenticated
  with check (public.owns_pending_trade(trade_id));

drop policy if exists "delete items on own pending trade" on public.trade_items;
create policy "delete items on own pending trade" on public.trade_items for delete to authenticated
  using (public.owns_pending_trade(trade_id));

-- league_rules
drop policy if exists "rules readable by league" on public.league_rules;
create policy "rules readable by league" on public.league_rules for select to authenticated
  using (public.is_league_member(league_id));

drop policy if exists "propose rules in my league" on public.league_rules;
create policy "propose rules in my league" on public.league_rules for insert to authenticated
  with check (proposer_id = auth.uid() and public.is_league_member(league_id));

drop policy if exists "commissioner resolves rules" on public.league_rules;
create policy "commissioner resolves rules" on public.league_rules for update to authenticated
  using (public.is_league_commissioner(league_id))
  with check (public.is_league_commissioner(league_id));

drop policy if exists "commissioner deletes rules" on public.league_rules;
create policy "commissioner deletes rules" on public.league_rules for delete to authenticated
  using (public.is_league_commissioner(league_id));

-- rule_votes
drop policy if exists "votes readable" on public.rule_votes;
create policy "votes readable" on public.rule_votes for select to authenticated
  using (public.can_see_rule(rule_id));

drop policy if exists "cast own vote" on public.rule_votes;
create policy "cast own vote" on public.rule_votes for insert to authenticated
  with check (voter_id = auth.uid() and public.can_see_rule(rule_id));

drop policy if exists "change own vote" on public.rule_votes;
create policy "change own vote" on public.rule_votes for update to authenticated
  using (voter_id = auth.uid()) with check (voter_id = auth.uid());

-- audit_log — append-only. An audit trail you can rewrite is not an audit trail.
drop policy if exists "audit readable by league" on public.audit_log;
create policy "audit readable by league" on public.audit_log for select to authenticated
  using (public.is_league_member(league_id));

drop policy if exists "append audit in my league" on public.audit_log;
create policy "append audit in my league" on public.audit_log for insert to authenticated
  with check (actor_id = auth.uid() and public.is_league_member(league_id));

-- ESPN tables — read-only to members. Writes come from the Edge Function with
-- the service_role key, which bypasses RLS. Do NOT add a write policy here.
drop policy if exists "espn players readable" on public.espn_players;
create policy "espn players readable" on public.espn_players for select to authenticated
  using (public.is_league_member(league_id));

drop policy if exists "espn teams readable" on public.espn_teams;
create policy "espn teams readable" on public.espn_teams for select to authenticated
  using (public.is_league_member(league_id));

drop policy if exists "espn rosters readable" on public.espn_rosters;
create policy "espn rosters readable" on public.espn_rosters for select to authenticated
  using (public.is_league_member(league_id));


-- ============================================================================
--  Triggers
-- ============================================================================
-- ⚠️ EACH AUTH PROVIDER NAMES THIS FIELD DIFFERENTLY.
-- Email signup sends `display_name` (we set it ourselves in Auth.jsx). Google
-- sends `full_name` AND `name`; other providers vary again. Reading only one of
-- them leaves every OAuth user with a blank name, which then shows up as
-- "Someone" all over the audit log. Fall back through the lot, then to the
-- local part of the email so the column is never empty.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, display_name)
  values (
    new.id,
    coalesce(
      nullif(new.raw_user_meta_data->>'display_name', ''),
      nullif(new.raw_user_meta_data->>'full_name', ''),
      nullif(new.raw_user_meta_data->>'name', ''),
      nullif(split_part(coalesce(new.email, ''), '@', 1), ''),
      'Manager'
    )
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users for each row execute function public.handle_new_user();

create or replace function public.stamp_resolved_at()
returns trigger language plpgsql as $$
begin
  if new.status is distinct from old.status
     and new.status::text not in ('pending', 'proposed') then
    new.resolved_at := coalesce(new.resolved_at, now());
  end if;
  return new;
end;
$$;

drop trigger if exists trades_stamp_resolved on public.trades;
create trigger trades_stamp_resolved before update on public.trades
  for each row execute function public.stamp_resolved_at();

drop trigger if exists rules_stamp_resolved on public.league_rules;
create trigger rules_stamp_resolved before update on public.league_rules
  for each row execute function public.stamp_resolved_at();

-- No manual promote step any more: whoever calls create_league() becomes that
-- league's commissioner inside the same transaction.
