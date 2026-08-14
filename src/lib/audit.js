import { supabase } from '../supabaseClient'

// ⚠️ SET THIS TO false IF YOUR DATABASE ALREADY WRITES audit_log FROM TRIGGERS.
// Client-side and trigger-side logging both work, but running both double-logs
// every action and the feed stops being trustworthy. One switch, one place.
export const AUDIT_FROM_CLIENT = true

export const AUDIT_ACTIONS = {
  TRADE_PROPOSED:  'trade.proposed',
  TRADE_ACCEPTED:  'trade.accepted',
  TRADE_REJECTED:  'trade.rejected',
  TRADE_COMPLETED: 'trade.completed',
  TRADE_VETOED:    'trade.vetoed',
  TRADE_DELETED:   'trade.deleted',
  RULE_ADDED:      'rule.added',
  RULE_UPDATED:    'rule.updated',
  RULE_DELETED:    'rule.deleted',
  // ⚠️ PROPOSALS ARE NOT RULES. Logging a deleted proposal as 'rule.deleted'
  // made the feed say "Bob deleted a rule" — with a Commissioner badge, because
  // that action is in COMMISH_ACTIONS — when no rule was touched and Bob is a
  // manager. That inverts the one invariant the proposals feature rests on.
  PROPOSAL_ADDED:    'proposal.added',
  PROPOSAL_ADOPTED:  'proposal.adopted',
  PROPOSAL_DECLINED: 'proposal.declined',
  PROPOSAL_DELETED:  'proposal.deleted',
  // Kept so older audit_log rows still render with a label instead of a raw
  // action string. Nothing writes these any more — the rulebook stores rules,
  // it does not run votes.
  RULE_PROPOSED:   'rule.proposed',
  RULE_VOTED:      'rule.voted',
  RULE_RATIFIED:   'rule.ratified',
  RULE_REJECTED:   'rule.rejected',
  LEAGUE_CREATED:  'league.created',
  LEAGUE_JOINED:   'league.joined',
  ESPN_CONNECTED:  'league.espn_connected',
  ESPN_SYNCED:     'league.espn_synced',
}

/**
 * Append one row to audit_log.
 *
 * Deliberately never throws. An audit write failing must not roll back or mask
 * the user-visible action that succeeded — if the trade went through and only
 * the log entry failed, reporting "trade failed" would be a lie.
 */
export async function logAudit({ leagueId, actorId, action, entityType, entityId, details = {} }) {
  if (!AUDIT_FROM_CLIENT) return
  if (!leagueId) { console.warn('[audit] skipped: no leagueId'); return }
  try {
    const { error } = await supabase.from('audit_log').insert({
      league_id: leagueId,
      actor_id: actorId,
      action,
      entity_type: entityType,
      entity_id: entityId,
      details,
    })
    if (error) console.warn('[audit] write failed:', error.message)
  } catch (err) {
    console.warn('[audit] write threw:', err)
  }
}
