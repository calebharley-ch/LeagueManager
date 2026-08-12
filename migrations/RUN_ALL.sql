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

-- ###########################################################################
-- 012_team_invite_codes.sql
-- ###########################################################################
-- ============================================================================
--  012 - a short, per-team invite code
--
--  Run after 011. Additive and idempotent.
--
--  The invite link already binds a team, but a UUID is not something you can
--  read down the phone or drop in a text. This adds a 6-character code per
--  invite that does exactly the same job.
--
--  Two codes now exist and they are NOT the same thing:
--    leagues.invite_code        league-wide, reusable, joins with NO team - the
--                               joiner types their own team name
--    league_invites.code        one team, one invite. Redeeming it joins the
--                               league AND binds that ESPN team, exactly like
--                               clicking the emailed link.
--
--  Alphabet excludes I, L, O, 0 and 1 - these get read aloud and typed by hand,
--  and that is where the confusion lives.
-- ============================================================================

create or replace function public.generate_team_invite_code()
returns text language plpgsql volatile set search_path = public as $$
declare
  v_alphabet text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  v_code text;
  v_i integer;
begin
  loop
    v_code := '';
    for v_i in 1..6 loop
      v_code := v_code || substr(v_alphabet, 1 + floor(random() * length(v_alphabet))::integer, 1);
    end loop;
    exit when not exists (select 1 from public.league_invites where code = v_code);
  end loop;
  return v_code;
end;
$$;

alter table public.league_invites add column if not exists code text;

-- Backfill before the not-null, or existing invites break the constraint.
update public.league_invites set code = public.generate_team_invite_code()
 where code is null;

alter table public.league_invites
  alter column code set default public.generate_team_invite_code();

create unique index if not exists league_invites_code_idx on public.league_invites (code);

do $$ begin
  alter table public.league_invites alter column code set not null;
exception when others then null; end $$;


-- -- Preview, unauthenticated ------------------------------------------------
--  Same contract as invite_preview: league name and team name only, never the
--  email address.
create or replace function public.invite_preview_by_code(p_code text)
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
  where upper(i.code) = upper(trim(p_code));
$$;

grant execute on function public.invite_preview_by_code(text) to anon, authenticated;


-- -- Redeem ------------------------------------------------------------------
--  Deliberately delegates to redeem_invite() rather than repeating it. The
--  rules about already being a member, or the team being taken, live in exactly
--  one place - two copies would drift the first time one changed.
create or replace function public.redeem_invite_by_code(p_code text)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_token uuid;
begin
  select token into v_token
    from public.league_invites
   where upper(code) = upper(trim(p_code));

  if v_token is null then
    raise exception 'That invite code is not valid';
  end if;

  return public.redeem_invite(v_token);
end;
$$;

grant execute on function public.redeem_invite_by_code(text) to authenticated;

-- ###########################################################################
-- 013_league_history.sql
-- ###########################################################################
-- ============================================================================
--  013 - league history
--
--  Run after 012. Additive and idempotent.
--
--  Read-only, hand-curated league record: career totals, champions, final
--  standings, points per season and the head-to-head grid. Seeded from the
--  standalone Cool Clan index page.
--
--  !! KEYED BY LEAGUE. This app is multi-league; a static file would show one
--  league's history to everybody who creates one.
--
--  One table with jsonb payloads rather than five typed tables. This is
--  display data - read whole, rendered as-is, never queried across rows - so a
--  schema per shape would buy nothing and cost a migration every time a chart
--  changes.
--
--  Updating it is a SQL paste once a season. If that becomes annoying, the fix
--  is a commissioner editor, not a different storage shape.
-- ============================================================================

create table if not exists public.league_history (
  league_id  uuid not null references public.leagues(id) on delete cascade,
  kind       text not null,
  payload    jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (league_id, kind)
);

alter table public.league_history enable row level security;

drop policy if exists "history readable by league" on public.league_history;
create policy "history readable by league" on public.league_history for select to authenticated
  using (public.is_league_member(league_id));

drop policy if exists "commissioner writes history" on public.league_history;
create policy "commissioner writes history" on public.league_history for insert to authenticated
  with check (public.is_league_commissioner(league_id));

drop policy if exists "commissioner updates history" on public.league_history;
create policy "commissioner updates history" on public.league_history for update to authenticated
  using (public.is_league_commissioner(league_id))
  with check (public.is_league_commissioner(league_id));

drop policy if exists "commissioner deletes history" on public.league_history;
create policy "commissioner deletes history" on public.league_history for delete to authenticated
  using (public.is_league_commissioner(league_id));


-- -- Seed --------------------------------------------------------------------
--  Targets the oldest league, same as the rule seeds. `on conflict do nothing`
--  so re-running never overwrites a correction made after the fact.
with target as (
  select l.id from public.leagues l
  -- where l.name = 'CoolClan'      -- uncomment and set if you have several
  order by l.created_at
  limit 1
)
insert into public.league_history (league_id, kind, payload)
select t.id, v.kind, v.payload::jsonb
from target t
cross join (values
  ('dynasty', '[{"name":"Sean Mulderig","seasons":12,"w":100,"l":64,"t":1,"pf":18046.8,"pa":16497.7,"playoffs":9,"champApps":6,"champs":5,"war":5.872,"champYears":[2016,2017,2022,2024,2025]},{"name":"Brett Pearce","seasons":12,"w":96,"l":68,"t":1,"pf":17593.8,"pa":17025.3,"playoffs":9,"champApps":2,"champs":1,"war":2.484,"champYears":[2020]},{"name":"Tim Esqueda","seasons":12,"w":89,"l":76,"t":0,"pf":17400.7,"pa":17137.4,"playoffs":6,"champApps":1,"champs":1,"war":1.026,"champYears":[2011]},{"name":"Danny Stein","seasons":12,"w":87,"l":78,"t":0,"pf":17728.1,"pa":17314.8,"playoffs":6,"champApps":4,"champs":0,"war":2.467,"champYears":[]},{"name":"Matt Hardy","seasons":8,"w":61,"l":48,"t":0,"pf":12223.7,"pa":11969,"playoffs":5,"champApps":1,"champs":1,"war":1.212,"champYears":[2019]},{"name":"Daniel Hegler","seasons":12,"w":78,"l":86,"t":1,"pf":17261.9,"pa":17103,"playoffs":3,"champApps":2,"champs":2,"war":-0.264,"champYears":[2012,2021]},{"name":"Caleb Harley","seasons":12,"w":75,"l":88,"t":2,"pf":16964.4,"pa":17777.9,"playoffs":4,"champApps":2,"champs":1,"war":-2.35,"champYears":[2018]},{"name":"Corey Ferback","seasons":12,"w":74,"l":91,"t":0,"pf":16669.5,"pa":17476.1,"playoffs":3,"champApps":3,"champs":2,"war":-3.19,"champYears":[2013,2023]},{"name":"Ben Dabbert","seasons":11,"w":69,"l":80,"t":2,"pf":15730.5,"pa":16038,"playoffs":4,"champApps":0,"champs":0,"war":-1.04,"champYears":[]},{"name":"Adrian Rafiee","seasons":11,"w":66,"l":84,"t":1,"pf":14645.8,"pa":15292.8,"playoffs":4,"champApps":1,"champs":1,"war":-4.739,"champYears":[2006]},{"name":"William Yeung","seasons":8,"w":44,"l":65,"t":0,"pf":11875.5,"pa":12336.2,"playoffs":2,"champApps":0,"champs":0,"war":-1.652,"champYears":[]},{"name":"Bill Dabbert","seasons":5,"w":34,"l":36,"t":0,"pf":7990.9,"pa":7551.8,"playoffs":3,"champApps":1,"champs":1,"war":1.647,"champYears":[2008]}]'),
  ('champions', '[{"year":2006,"name":"Adrian Rafiee","team":"(pre-ESPN)","record":"\u2014","pf":"\u2014","preEspn":true},{"year":2007,"name":"Duane Palmer","team":"(departed)","record":"\u2014","pf":"\u2014","preEspn":true},{"year":2008,"name":"Bill Dabbert","team":"(pre-ESPN)","record":"\u2014","pf":"\u2014","preEspn":true},{"year":2009,"name":"Evan Stanner","team":"(departed)","record":"\u2014","pf":"\u2014","preEspn":true},{"year":2010,"name":"Taylor Winchell","team":"(departed)","record":"\u2014","pf":"\u2014","preEspn":true},{"year":2011,"name":"Tim Esqueda","team":"(pre-ESPN)","record":"\u2014","pf":"\u2014","preEspn":true},{"year":2012,"name":"Daniel Hegler","team":"(pre-ESPN)","record":"\u2014","pf":"\u2014","preEspn":true},{"year":2013,"name":"Corey Ferback","team":"(pre-ESPN)","record":"\u2014","pf":"\u2014","preEspn":true},{"year":2014,"name":"Kris Shewmaker","team":"(departed)","record":"10-4","pf":1467},{"year":2015,"name":"Ben Elson","team":"(departed)","record":"10-4","pf":1405},{"year":2016,"name":"Sean Mulderig","team":"TEAM RAMROD","record":"8-5","pf":1303},{"year":2017,"name":"Sean Mulderig","team":"TEAM RAMROD","record":"9-5","pf":1309},{"year":2018,"name":"Caleb Harley","team":"Philip''s Children","record":"8-5","pf":1588},{"year":2019,"name":"Matt Hardy","team":"Fresh Kicks","record":"10-3","pf":1672.6},{"year":2020,"name":"Brett Pearce","team":"Capital Pwnshment","record":"8-5","pf":1464.7},{"year":2021,"name":"Daniel Hegler","team":"Team Adonai","record":"10-4","pf":1662.9},{"year":2022,"name":"Sean Mulderig","team":"TEAM RAMROD","record":"12-2","pf":1774.6},{"year":2023,"name":"Corey Ferback","team":"Two Hands (Required)","record":"9-5","pf":1565.5},{"year":2024,"name":"Sean Mulderig","team":"TEAM RAMROD","record":"9-5","pf":1591.7},{"year":2025,"name":"Sean Mulderig","team":"TEAM RAMROD","record":"11-3","pf":1789.1}]'),
  ('standings', '{"2014":[{"n":"Kris Shewmaker","r":1},{"n":"Caleb Harley","r":2},{"n":"Brett Pearce","r":3},{"n":"Ben Elson","r":4},{"n":"Evan Stanner","r":5},{"n":"Tim Esqueda","r":6},{"n":"Daniel Hegler","r":7},{"n":"Sean Mulderig","r":8},{"n":"Ben Dabbert","r":9},{"n":"Danny Stein","r":10},{"n":"Corey Ferback","r":11},{"n":"Taylor Winchell","r":12}],"2015":[{"n":"Ben Elson","r":1},{"n":"Evan Stanner","r":2},{"n":"Caleb Harley","r":3},{"n":"Adrian Rafiee","r":4},{"n":"Sean Mulderig","r":5},{"n":"Greg Haskett","r":6},{"n":"Tim Esqueda","r":7},{"n":"Daniel Hegler","r":8},{"n":"Danny Stein","r":9},{"n":"Corey Ferback","r":10},{"n":"Kris Shewmaker","r":11},{"n":"Brett Pearce","r":12}],"2016":[{"n":"Sean Mulderig","r":1},{"n":"Corey Ferback","r":2},{"n":"Tim Esqueda","r":3},{"n":"Danny Stein","r":4},{"n":"Kris Shewmaker","r":5},{"n":"Evan Stanner","r":6},{"n":"Adrian Rafiee","r":7},{"n":"Caleb Harley","r":8},{"n":"Brett Pearce","r":9},{"n":"Daniel Hegler","r":10},{"n":"Ben Elson","r":11},{"n":"Ben Dabbert","r":12}],"2017":[{"n":"Sean Mulderig","r":1},{"n":"Tim Esqueda","r":2},{"n":"Brett Pearce","r":3},{"n":"Ben Elson","r":4},{"n":"Danny Stein","r":5},{"n":"Adrian Rafiee","r":6},{"n":"Daniel Hegler","r":7},{"n":"Ben Dabbert","r":8},{"n":"David Zarata","r":9},{"n":"Caleb Harley","r":10},{"n":"Corey Ferback","r":11},{"n":"Evan Stanner","r":12}],"2018":[{"n":"Caleb Harley","r":1},{"n":"Corey Ferback","r":2},{"n":"Matt Hardy","r":3},{"n":"Ben Stein","r":4},{"n":"Sean Mulderig","r":5},{"n":"Daniel Hegler","r":6},{"n":"Adrian Rafiee","r":7},{"n":"Danny Stein","r":8},{"n":"William Yeung","r":9},{"n":"Ben Dabbert","r":10},{"n":"Tim Esqueda","r":11},{"n":"Brett Pearce","r":12}],"2019":[{"n":"Matt Hardy","r":1},{"n":"Sean Mulderig","r":2},{"n":"Caleb Harley","r":3},{"n":"Ben Dabbert","r":4},{"n":"Adrian Rafiee","r":5},{"n":"Brett Pearce","r":6},{"n":"William Yeung","r":7},{"n":"Tim Esqueda","r":8},{"n":"Corey Ferback","r":9},{"n":"Daniel Hegler","r":10},{"n":"Nicholas Burruss","r":11},{"n":"Danny Stein","r":12}],"2020":[{"n":"Brett Pearce","r":1},{"n":"Daniel Hegler","r":2},{"n":"Danny Stein","r":3},{"n":"Matt Hardy","r":4},{"n":"Tim Esqueda","r":5},{"n":"Ben Dabbert","r":6},{"n":"Corey Ferback","r":7},{"n":"William Yeung","r":8},{"n":"Sean Mulderig","r":9},{"n":"Nicholas Burruss","r":10},{"n":"Adrian Rafiee","r":11},{"n":"Caleb Harley","r":12}],"2021":[{"n":"Daniel Hegler","r":1},{"n":"Danny Stein","r":2},{"n":"Ben Dabbert","r":3},{"n":"Bill Dabbert","r":4},{"n":"Sean Mulderig","r":5},{"n":"Brett Pearce","r":6},{"n":"Corey Ferback","r":7},{"n":"Adrian Rafiee","r":8},{"n":"Matt Hardy","r":9},{"n":"Caleb Harley","r":10},{"n":"Tim Esqueda","r":11},{"n":"William Yeung","r":12}],"2022":[{"n":"Sean Mulderig","r":1},{"n":"Danny Stein","r":2},{"n":"Bill Dabbert","r":3},{"n":"William Yeung","r":4},{"n":"Brett Pearce","r":5},{"n":"Tim Esqueda","r":6},{"n":"Daniel Hegler","r":7},{"n":"Matt Hardy","r":8},{"n":"Corey Ferback","r":9},{"n":"Caleb Harley","r":10},{"n":"Ben Dabbert","r":11},{"n":"Adrian Rafiee","r":12}],"2023":[{"n":"Corey Ferback","r":1},{"n":"Danny Stein","r":2},{"n":"Tim Esqueda","r":3},{"n":"Sean Mulderig","r":4},{"n":"Brett Pearce","r":5},{"n":"Adrian Rafiee","r":6},{"n":"William Yeung","r":7},{"n":"Bill Dabbert","r":8},{"n":"Ben Dabbert","r":9},{"n":"Matt Hardy","r":10},{"n":"Caleb Harley","r":11},{"n":"Daniel Hegler","r":12}],"2024":[{"n":"Sean Mulderig","r":1},{"n":"Danny Stein","r":2},{"n":"Brett Pearce","r":3},{"n":"Matt Hardy","r":4},{"n":"Adrian Rafiee","r":5},{"n":"Bill Dabbert","r":6},{"n":"Ben Dabbert","r":7},{"n":"William Yeung","r":8},{"n":"Corey Ferback","r":9},{"n":"Daniel Hegler","r":10},{"n":"Tim Esqueda","r":11},{"n":"Caleb Harley","r":12}],"2025":[{"n":"Sean Mulderig","r":1},{"n":"Brett Pearce","r":2},{"n":"Tim Esqueda","r":3},{"n":"Ben Dabbert","r":4},{"n":"Matt Hardy","r":5},{"n":"William Yeung","r":6},{"n":"Caleb Harley","r":7},{"n":"Adrian Rafiee","r":8},{"n":"Daniel Hegler","r":9},{"n":"Corey Ferback","r":10},{"n":"Danny Stein","r":11},{"n":"Bill Dabbert","r":12}]}'),
  ('pf_by_year', '{"Sean Mulderig":{"2018":1603,"2019":1422.5,"2020":1433,"2021":1669.9,"2022":1774.6,"2023":1563,"2024":1591.7,"2025":1789.1},"Brett Pearce":{"2018":1286.8,"2019":1316.4,"2020":1464.7,"2021":1602.2,"2022":1380.9,"2023":1707.3,"2024":1609.6,"2025":1718.9},"Danny Stein":{"2018":1530.6,"2019":1220.6,"2020":1653.3,"2021":1801.9,"2022":1696.9,"2023":1681.1,"2024":1597.9,"2025":1593.8},"Tim Esqueda":{"2018":1358.9,"2019":1395.6,"2020":1506,"2021":1418.6,"2022":1464.2,"2023":1557.7,"2024":1478,"2025":1646.7},"Daniel Hegler":{"2018":1391.8,"2019":1534.3,"2020":1387.8,"2021":1662.9,"2022":1283.8,"2023":1487.6,"2024":1529.7,"2025":1613},"Caleb Harley":{"2018":1588,"2019":1454.8,"2020":1413.9,"2021":1401.9,"2022":1509,"2023":1460.6,"2024":1387.1,"2025":1439.1},"Corey Ferback":{"2018":1461.3,"2019":1357,"2020":1419,"2021":1536.2,"2022":1378.6,"2023":1565.5,"2024":1565.2,"2025":1492.7},"Matt Hardy":{"2018":1627.3,"2019":1672.6,"2020":1541.8,"2021":1444.3,"2022":1360.8,"2023":1488.5,"2024":1620.1,"2025":1468.3}}'),
  ('h2h', '{"Sean Mulderig":{"Brett Pearce":"9-6","Tim Esqueda":"10-7","Danny Stein":"9-6","Daniel Hegler":"12-5","Caleb Harley":"11-3","Corey Ferback":"9-4","Ben Dabbert":"11-4","Adrian Rafiee":"9-4","Matt Hardy":"6-3","William Yeung":"6-3","Bill Dabbert":"3-4"},"Brett Pearce":{"Sean Mulderig":"6-9","Tim Esqueda":"9-6","Danny Stein":"5-10","Daniel Hegler":"11-5","Caleb Harley":"7-7","Corey Ferback":"14-3","Ben Dabbert":"8-3","Adrian Rafiee":"10-3","Matt Hardy":"4-4","William Yeung":"6-4","Bill Dabbert":"3-4"},"Tim Esqueda":{"Sean Mulderig":"7-10","Brett Pearce":"6-9","Danny Stein":"9-5","Daniel Hegler":"9-6","Caleb Harley":"8-6","Corey Ferback":"6-9","Ben Dabbert":"7-8","Adrian Rafiee":"11-3","Matt Hardy":"4-7","William Yeung":"7-1","Bill Dabbert":"3-3"},"Danny Stein":{"Sean Mulderig":"6-9","Brett Pearce":"10-5","Tim Esqueda":"5-9","Daniel Hegler":"7-8","Caleb Harley":"8-8","Corey Ferback":"7-6","Ben Dabbert":"9-5","Adrian Rafiee":"7-5","Matt Hardy":"7-3","William Yeung":"6-4","Bill Dabbert":"5-4"},"Daniel Hegler":{"Sean Mulderig":"5-12","Brett Pearce":"5-11","Tim Esqueda":"6-9","Danny Stein":"8-7","Caleb Harley":"7-7","Corey Ferback":"8-5","Ben Dabbert":"8-5","Adrian Rafiee":"9-4","Matt Hardy":"3-8","William Yeung":"5-5","Bill Dabbert":"3-3"},"Caleb Harley":{"Sean Mulderig":"3-11","Brett Pearce":"7-7","Tim Esqueda":"6-8","Danny Stein":"8-8","Daniel Hegler":"7-7","Corey Ferback":"7-9","Ben Dabbert":"4-10","Adrian Rafiee":"8-6","Matt Hardy":"3-6","William Yeung":"7-5","Bill Dabbert":"2-4"},"Corey Ferback":{"Sean Mulderig":"4-9","Brett Pearce":"3-14","Tim Esqueda":"9-6","Danny Stein":"6-7","Daniel Hegler":"5-8","Caleb Harley":"9-7","Ben Dabbert":"6-8","Adrian Rafiee":"7-8","Matt Hardy":"3-7","William Yeung":"6-6","Bill Dabbert":"4-1"},"Ben Dabbert":{"Sean Mulderig":"4-11","Brett Pearce":"3-8","Tim Esqueda":"8-7","Danny Stein":"5-9","Daniel Hegler":"5-8","Caleb Harley":"10-4","Corey Ferback":"8-6","Adrian Rafiee":"6-8","Matt Hardy":"5-6","William Yeung":"4-5","Bill Dabbert":"4-2"},"Adrian Rafiee":{"Sean Mulderig":"4-9","Brett Pearce":"3-10","Tim Esqueda":"3-11","Danny Stein":"5-7","Daniel Hegler":"4-9","Caleb Harley":"6-8","Corey Ferback":"8-7","Ben Dabbert":"8-6","Matt Hardy":"6-4","William Yeung":"6-4","Bill Dabbert":"4-3"},"Matt Hardy":{"Sean Mulderig":"3-6","Brett Pearce":"4-4","Tim Esqueda":"7-4","Danny Stein":"3-7","Daniel Hegler":"8-3","Caleb Harley":"6-3","Corey Ferback":"7-3","Ben Dabbert":"6-5","Adrian Rafiee":"4-6","William Yeung":"8-2","Bill Dabbert":"2-4"},"William Yeung":{"Sean Mulderig":"3-6","Brett Pearce":"4-6","Tim Esqueda":"1-7","Danny Stein":"4-6","Daniel Hegler":"5-5","Caleb Harley":"5-7","Corey Ferback":"6-6","Ben Dabbert":"5-4","Adrian Rafiee":"4-6","Matt Hardy":"2-8","Bill Dabbert":"3-2"},"Bill Dabbert":{"Sean Mulderig":"4-3","Brett Pearce":"4-3","Tim Esqueda":"3-3","Danny Stein":"4-5","Daniel Hegler":"3-3","Caleb Harley":"4-2","Corey Ferback":"1-4","Ben Dabbert":"2-4","Adrian Rafiee":"3-4","Matt Hardy":"4-2","William Yeung":"2-3"}}'),
  ('core', '["Sean Mulderig","Brett Pearce","Tim Esqueda","Danny Stein","Daniel Hegler","Caleb Harley","Corey Ferback","Ben Dabbert","Adrian Rafiee","Matt Hardy","William Yeung","Bill Dabbert"]'),
  ('palette', '["#f0c040","#5b9cf6","#4caf88","#e05555","#b97cff","#ff9944","#44ddcc","#ff66aa","#88cc44","#cc8844","#66aaff","#aabbcc"]')
) as v(kind, payload)
on conflict (league_id, kind) do nothing;

-- ###########################################################################
-- 014_rule_proposals.sql
-- ###########################################################################
-- ============================================================================
--  014 - rule proposals for next season
--
--  Run after 013. Additive and idempotent.
--
--  !! SEPARATE FROM league_rules ON PURPOSE. The rulebook is what the league
--  has AGREED; this is what somebody wants to argue about at the draft. Mixing
--  them would mean a proposal nobody has voted on sitting in the book looking
--  like law, which is exactly the confusion the rulebook exists to prevent.
--
--  No voting engine here. The league votes in person - see the in-person draft
--  rule - so this records the idea and who raised it, and the commissioner
--  records the outcome afterwards. Adopting one writes a real rule into
--  league_rules and leaves the proposal marked adopted for the trail.
-- ============================================================================

do $$ begin create type proposal_status as enum ('open', 'adopted', 'declined');
exception when duplicate_object then null; end $$;

create table if not exists public.rule_proposals (
  id            uuid primary key default gen_random_uuid(),
  league_id     uuid not null references public.leagues(id) on delete cascade,
  proposer_id   uuid not null references public.profiles(id) on delete cascade,
  title         text not null,
  description   text,
  category      rule_category not null,
  target_season integer not null,
  status        proposal_status not null default 'open',
  resolved_by   uuid references public.profiles(id) on delete set null,
  resolved_at   timestamptz,
  created_at    timestamptz not null default now()
);

create index if not exists rule_proposals_league_idx
  on public.rule_proposals (league_id, status, created_at desc);

alter table public.rule_proposals enable row level security;

-- Everyone in the league reads them - the point is that anyone can see what has
-- been put forward.
drop policy if exists "proposals readable by league" on public.rule_proposals;
create policy "proposals readable by league" on public.rule_proposals for select to authenticated
  using (public.is_league_member(league_id));

-- ANY member can raise one. This is the one place in the app where a manager
-- writes something the commissioner did not initiate, and that is deliberate.
drop policy if exists "members raise proposals" on public.rule_proposals;
create policy "members raise proposals" on public.rule_proposals for insert to authenticated
  with check (proposer_id = auth.uid() and public.is_league_member(league_id));

-- Authors tidy up their own while it is still open; commissioners resolve any.
drop policy if exists "author or commissioner edits proposal" on public.rule_proposals;
create policy "author or commissioner edits proposal" on public.rule_proposals for update to authenticated
  using (
    (proposer_id = auth.uid() and status = 'open')
    or public.is_league_commissioner(league_id)
  )
  with check (
    (proposer_id = auth.uid() and status = 'open')
    or public.is_league_commissioner(league_id)
  );

drop policy if exists "author or commissioner deletes proposal" on public.rule_proposals;
create policy "author or commissioner deletes proposal" on public.rule_proposals for delete to authenticated
  using (
    (proposer_id = auth.uid() and status = 'open')
    or public.is_league_commissioner(league_id)
  );


-- -- Adopt -------------------------------------------------------------------
--  Writes the proposal into the rulebook and marks it adopted, in one
--  transaction. Done as two client calls, a failure between them either loses
--  the rule or leaves a proposal that claims to be adopted but is not in the
--  book.
create or replace function public.adopt_proposal(p_proposal uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_p    public.rule_proposals%rowtype;
  v_rule uuid;
begin
  select * into v_p from public.rule_proposals where id = p_proposal;
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
    (v_p.league_id, auth.uid(), v_p.title, v_p.description, v_p.category,
     v_p.target_season, 'passed')
  returning id into v_rule;

  update public.rule_proposals
     set status = 'adopted', resolved_by = auth.uid(), resolved_at = now()
   where id = p_proposal;

  insert into public.audit_log (league_id, actor_id, action, entity_type, entity_id, details)
  values (v_p.league_id, auth.uid(), 'rule.added', 'rule', v_rule,
          jsonb_build_object('title', v_p.title, 'category', v_p.category,
                             'from_proposal', true));

  return v_rule;
end;
$$;

grant execute on function public.adopt_proposal(uuid) to authenticated;
