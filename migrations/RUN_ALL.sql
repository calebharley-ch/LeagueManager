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

-- ###########################################################################
-- 006_invite_tokens.sql
-- ###########################################################################
-- ============================================================================
--  006 - one-click invites
--
--  Run after 005. Additive and idempotent.
--
--  Before: an invite emailed the league-wide code, and the recipient had to
--  paste it, then pick their own team from a dropdown. Two chances to get it
--  wrong, and the code is the same secret for everybody.
--
--  After: each invite carries its own token. The link redeems it, joins the
--  league, and binds the account to the ESPN team the commissioner chose. The
--  league code still exists for anyone joining without an invite.
-- ============================================================================

alter table public.league_invites
  add column if not exists token       uuid not null default gen_random_uuid(),
  add column if not exists accepted_at timestamptz,
  add column if not exists accepted_by uuid references public.profiles(id) on delete set null;

-- The token IS the credential in the emailed link, so it must be unique.
create unique index if not exists league_invites_token_idx
  on public.league_invites (token);


-- -- What the invite is for, readable WITHOUT an account ---------------------
--  The recipient has not signed up yet, so this must work unauthenticated.
--
--  !! RETURNS NO EMAIL ADDRESS. Only the league name and the team name, so a
--  guessed token leaks nothing but two strings the recipient was told anyway.
--  Token is a v4 uuid; guessing one is not a realistic attack.
create or replace function public.invite_preview(p_token uuid)
returns table (league_name text, team_name text, already_accepted boolean)
language sql security definer set search_path = public stable as $$
  select l.name,
         coalesce(t.team_name, 'Team ' || i.espn_team_id::text),
         i.accepted_at is not null
  from public.league_invites i
  join public.leagues l on l.id = i.league_id
  left join public.espn_teams t
    on t.league_id = i.league_id
   and t.espn_team_id = i.espn_team_id
   and t.season = (select max(season) from public.espn_teams
                    where league_id = i.league_id)
  where i.token = p_token;
$$;

grant execute on function public.invite_preview(uuid) to anon, authenticated;


-- -- Redeem ------------------------------------------------------------------
--  Joins the league AND binds the ESPN team in one transaction. SECURITY
--  DEFINER because a non-member cannot SELECT the league or the invite - this
--  function is the only door through the RLS, same pattern as join_league().
create or replace function public.redeem_invite(p_token uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_invite  public.league_invites%rowtype;
  v_team    text;
  v_existing uuid;
begin
  if auth.uid() is null then
    raise exception 'You must be signed in to accept an invite';
  end if;

  select * into v_invite from public.league_invites where token = p_token;
  if not found then
    raise exception 'That invite link is not valid';
  end if;

  -- Already in this league? Idempotent - clicking the link twice, or after
  -- joining by code, must not error or duplicate.
  select id into v_existing from public.league_members
   where league_id = v_invite.league_id and profile_id = auth.uid();
  if v_existing is not null then
    update public.league_members
       set espn_team_id = coalesce(espn_team_id, v_invite.espn_team_id)
     where id = v_existing;
    return v_invite.league_id;
  end if;

  -- Someone else already claimed this team. Do NOT silently hand it over.
  if exists (
    select 1 from public.league_members
     where league_id = v_invite.league_id
       and espn_team_id = v_invite.espn_team_id
  ) then
    raise exception 'That team has already been claimed by another manager';
  end if;

  select coalesce(t.team_name, 'Team ' || v_invite.espn_team_id::text)
    into v_team
    from (select 1) dummy
    left join public.espn_teams t
      on t.league_id = v_invite.league_id
     and t.espn_team_id = v_invite.espn_team_id
     and t.season = (select max(season) from public.espn_teams
                      where league_id = v_invite.league_id)
   limit 1;

  insert into public.league_members (league_id, profile_id, team_name, role, espn_team_id)
  values (v_invite.league_id, auth.uid(),
          coalesce(v_team, 'Team ' || v_invite.espn_team_id::text),
          'manager', v_invite.espn_team_id);

  update public.league_invites
     set accepted_at = now(), accepted_by = auth.uid()
   where token = p_token;

  insert into public.audit_log (league_id, actor_id, action, entity_type, entity_id, details)
  values (v_invite.league_id, auth.uid(), 'league.joined', 'league', v_invite.league_id,
          jsonb_build_object('team_name', v_team, 'via', 'invite'));

  return v_invite.league_id;
end;
$$;

grant execute on function public.redeem_invite(uuid) to authenticated;

-- ###########################################################################
-- 007_trade_voting.sql
-- ###########################################################################
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


-- -- trade_votes -------------------------------------------------------------
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


-- -- Cast a vote -------------------------------------------------------------
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

-- ###########################################################################
-- 008_commissioners_and_rules.sql
-- ###########################################################################
-- ============================================================================
--  008 - co-commissioners, commissioner-only rules, and a privilege-escalation
--        fix that came with them
--
--  Run after 007. Additive and idempotent.
-- ============================================================================

-- -- Only the commissioner writes the rulebook -------------------------------
--  Was: any member could insert. The rulebook is the league's record of what
--  was agreed, not a suggestion box.
drop policy if exists "propose rules in my league" on public.league_rules;
drop policy if exists "commissioner adds rules" on public.league_rules;
create policy "commissioner adds rules" on public.league_rules for insert to authenticated
  with check (proposer_id = auth.uid() and public.is_league_commissioner(league_id));


-- -- !! PRIVILEGE ESCALATION FIX ---------------------------------------------
--  The existing update policy on league_members is:
--
--    using (profile_id = auth.uid() or public.is_league_commissioner(league_id))
--
--  which is right for team_name and espn_team_id - you edit your own row. But
--  `role` is on the same row, so ANY manager could set their own role to
--  'commissioner' and take over the league. RLS cannot compare OLD to NEW, so
--  the column needs a trigger.
--
--  Also stops the last commissioner demoting themselves, which would leave the
--  league with nobody able to sync ESPN, invite anyone, or write a rule.
create or replace function public.guard_member_role()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_commish_count integer;
begin
  if new.role is distinct from old.role then
    if not public.is_league_commissioner(old.league_id) then
      raise exception 'Only a commissioner can change roles';
    end if;

    if old.role = 'commissioner' and new.role <> 'commissioner' then
      select count(*) into v_commish_count
        from public.league_members
       where league_id = old.league_id and role = 'commissioner';
      if v_commish_count <= 1 then
        raise exception 'A league must keep at least one commissioner';
      end if;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists league_members_guard_role on public.league_members;
create trigger league_members_guard_role
  before update on public.league_members
  for each row execute function public.guard_member_role();


-- -- Same protection on the way out ------------------------------------------
--  The delete policy already refuses to remove yourself, but a commissioner
--  could still delete the OTHER commissioner and then be removed by them in a
--  race. Cheap to guard.
create or replace function public.guard_member_delete()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_commish_count integer;
begin
  if old.role = 'commissioner' then
    select count(*) into v_commish_count
      from public.league_members
     where league_id = old.league_id and role = 'commissioner';
    if v_commish_count <= 1 then
      raise exception 'A league must keep at least one commissioner';
    end if;
  end if;
  return old;
end;
$$;

drop trigger if exists league_members_guard_delete on public.league_members;
create trigger league_members_guard_delete
  before delete on public.league_members
  for each row execute function public.guard_member_delete();

-- ###########################################################################
-- 009_parties_can_vote.sql
-- ###########################################################################
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

-- ###########################################################################
-- 010_parties_auto_approve.sql
-- ###########################################################################
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

-- ###########################################################################
-- 011_espn_settlement.sql
-- ###########################################################################
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
