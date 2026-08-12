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


-- ── What the invite is for, readable WITHOUT an account ─────────────────────
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


-- ── Redeem ──────────────────────────────────────────────────────────────────
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
