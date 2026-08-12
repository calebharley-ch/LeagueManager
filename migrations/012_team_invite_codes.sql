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


-- ── Preview, unauthenticated ────────────────────────────────────────────────
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


-- ── Redeem ──────────────────────────────────────────────────────────────────
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
