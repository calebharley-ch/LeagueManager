-- ============================================================================
--  005 — invite addresses for teams that have not registered
--
--  Run after 004. Additive and idempotent.
--
--  Its own table rather than a column on espn_teams, for two reasons:
--    1. espn_teams is upserted by every sync. A column there is one careless
--       payload change away from being wiped.
--    2. These are other people's personal email addresses. They deserve their
--       own RLS boundary, not whatever espn_teams happens to allow.
--
--  ⚠️ COMMISSIONER-ONLY, INCLUDING SELECT. Managers can see who has registered;
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
