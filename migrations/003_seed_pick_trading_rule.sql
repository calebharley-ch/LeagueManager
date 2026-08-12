-- ============================================================================
--  003 — draft pick trading rule
--
--  Run after 002. Same idempotent guard: safe to re-run, and it will not
--  overwrite the rule if you have since edited it in the app.
--
--  ⚠️ This rule is ALSO enforced in code, and the two must agree:
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
