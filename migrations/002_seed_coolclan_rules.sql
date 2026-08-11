-- ============================================================================
--  002 — the three rules CoolClan already plays by
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
  (
    'Keeper rules',
    E'• A player cannot be kept two years in a row.\n'
    E'• A first-round draft pick cannot be kept.\n'
    E'• A free agent counts as a 9th-round pick.\n'
    E'• If a player is traded, he still counts at his original draft position.\n'
    E'• If a player is ever dropped, he always counts toward the round he was originally drafted in.',
    'Draft'
  ),
  (
    'In-person draft',
    'The CoolClan draft is held in person every other year. Agreed by the league.',
    'Governance'
  ),
  (
    'Last-place punishment',
    E'The last-place finisher gives a 30-minute presentation about everyone''s lives, '
    E'delivered before the draft.',
    'Governance'
  )
) as r(title, description, category)
where not exists (
  select 1 from public.league_rules existing
  where existing.league_id = t.id and existing.title = r.title
);
