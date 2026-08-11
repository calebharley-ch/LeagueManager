-- ============================================================================
--  004 — per-manager email opt-out
--
--  Run after 003. Additive and idempotent.
--
--  Default TRUE: a trade sitting unanswered because nobody knew about it is the
--  problem this feature exists to solve, so notifications are on unless someone
--  turns them off. The toggle lives on the MEMBERSHIP, not the profile — you
--  might want mail from one league and not another.
-- ============================================================================

alter table public.league_members
  add column if not exists email_notifications boolean not null default true;
