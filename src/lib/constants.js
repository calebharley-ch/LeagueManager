// Shared vocabulary. These strings are database enum values — changing one here
// without changing schema.sql produces a 22P02 "invalid input value for enum".

export const RULE_CATEGORIES = ['Scoring', 'Roster', 'Draft', 'Financial', 'Governance']

export const POSITIONS = ['QB', 'RB', 'WR', 'TE', 'K', 'D/ST']

export const PICK_ROUNDS = Array.from({ length: 12 }, (_, i) => i + 1)

// ⚠️ LEAGUE RULE, NOT A UI CHOICE: only NEXT year's picks may be traded.
// CoolClan does not trade multi-year pick futures, so this is a one-element
// list rather than a rolling window. It is also the window `derivePicks` shows
// ownership for — a pick you cannot trade is not worth tracking.
export const PICK_YEARS = [new Date().getFullYear() + 1]

// ⚠️ LEAGUE RULE: a team may trade away at most this many of its OWN picks.
// Counted across pending, accepted and completed trades — a pick you have
// already promised is spent even if the trade has not been finalised.
// Picks you ACQUIRED from another team do not count against your limit.
export const MAX_OWN_PICKS_TRADED = 3

export const SEASONS = (() => {
  const now = new Date().getFullYear()
  return [now, now + 1, now + 2]
})()

// Asset colour coding, used everywhere an asset is rendered so the legend in
// the builder and the badges in the feed can never drift apart.
export const ASSET_STYLES = {
  player: {
    label: 'Player',
    chip: 'bg-purple-500/15 text-purple-300 ring-purple-500/30',
    dot: 'bg-purple-400',
  },
  faab: {
    label: 'FAAB',
    chip: 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/30',
    dot: 'bg-emerald-400',
  },
  pick: {
    label: 'Draft Pick',
    chip: 'bg-sky-500/15 text-sky-300 ring-sky-500/30',
    dot: 'bg-sky-400',
  },
}

// A trade now passes through TWO gates: the other manager, then the league.
// 'accepted' therefore means "both parties agreed, the league is voting" — not
// "done". Renaming the enum in Postgres is not worth a migration, so the label
// carries the meaning and this is the only place it is defined.
export const TRADE_STATUS_STYLES = {
  pending:   { label: 'Awaiting manager', chip: 'bg-amber-500/15 text-amber-300 ring-amber-500/30' },
  accepted:  { label: 'League vote',      chip: 'bg-sky-500/15 text-sky-300 ring-sky-500/30' },
  completed: { label: 'Approved',         chip: 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/30' },
  rejected:  { label: 'Declined',         chip: 'bg-slate-500/15 text-slate-300 ring-slate-500/30' },
  vetoed:    { label: 'Vetoed',           chip: 'bg-rose-500/15 text-rose-300 ring-rose-500/30' },
}

// The rulebook stores what the league has agreed; it is not a voting engine.
// The database enum still reads proposed/passed/rejected because renaming a
// Postgres enum in place is not worth a migration — these are the labels the
// league actually uses for those three states.
export const RULE_STATUS_STYLES = {
  passed:   { label: 'Adopted',  chip: 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/30' },
  proposed: { label: 'Draft',    chip: 'bg-amber-500/15 text-amber-300 ring-amber-500/30' },
  rejected: { label: 'Repealed', chip: 'bg-slate-500/15 text-slate-400 ring-slate-500/30' },
}

/**
 * Human-readable one-liner for a trade asset.
 *
 * `ownerName` is passed in rather than looked up here because a pick's original
 * owner can be either a registered account or an unclaimed ESPN team, and only
 * the caller holds the unified team list that resolves both.
 */
export function describeAsset(item, ownerName = null) {
  if (item.item_type === 'faab') return `$${item.faab_amount} FAAB`
  if (item.item_type === 'player') {
    return item.player_position
      ? `${item.player_name} (${item.player_position})`
      : item.player_name
  }
  const base = `${item.pick_year} Round ${item.pick_round}`
  return ownerName ? `${base} — ${ownerName}` : base
}

/** "3 minutes ago" / "Mar 4" — short, and never a raw ISO string in the UI. */
export function timeAgo(iso) {
  if (!iso) return ''
  const then = new Date(iso)
  const secs = Math.floor((Date.now() - then.getTime()) / 1000)
  if (secs < 60) return 'just now'
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  if (days < 7) return `${days}d ago`
  return then.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}
