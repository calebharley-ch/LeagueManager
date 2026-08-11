import { PICK_YEARS } from './constants'

/**
 * The league roster of TEAMS, which is not the same thing as the list of
 * accounts.
 *
 * A team is an ESPN team. An account CLAIMS one by setting
 * league_members.espn_team_id. Until someone claims it the team is still real —
 * it still holds picks, still has FAAB, and you can still propose a trade to
 * it. Building the app around registered accounts is what left the trade
 * dropdown empty in a twelve-team league with one signup.
 *
 * Returns one row per team, newest-season ESPN teams first, then any member who
 * has not linked themselves to an ESPN team yet (so a commissioner who has not
 * picked their team never vanishes from their own league).
 */
export function buildTeams({ espnTeams = [], members = [] }) {
  const memberByEspnId = new Map()
  for (const m of members) {
    if (m.espn_team_id != null) memberByEspnId.set(m.espn_team_id, m)
  }

  const teams = espnTeams.map((t) => {
    const member = memberByEspnId.get(t.espn_team_id) ?? null
    return {
      key: `espn:${t.espn_team_id}`,
      espn_team_id: t.espn_team_id,
      profile_id: member?.profile_id ?? null,
      // A claimed team shows the name its owner chose; ESPN's name is the
      // fallback, not the override.
      team_name: member?.team_name || t.team_name || `Team ${t.espn_team_id}`,
      espn_team_name: t.team_name ?? null,
      member,
      claimed: !!member,
      role: member?.role ?? null,
      wins: t.wins ?? null,
      losses: t.losses ?? null,
      faab_spent: t.faab_spent ?? null,
    }
  })

  const linked = new Set(teams.map((t) => t.profile_id).filter(Boolean))
  for (const m of members) {
    if (linked.has(m.profile_id)) continue
    teams.push({
      key: `member:${m.profile_id}`,
      espn_team_id: null,
      profile_id: m.profile_id,
      team_name: m.team_name,
      espn_team_name: null,
      member: m,
      claimed: true,
      unlinked: true,          // has an account, has not said which ESPN team
      role: m.role,
      wins: null, losses: null, faab_spent: null,
    })
  }

  return teams
}

/** Which team is a trade's proposer / receiver? Either identity may be used. */
export function findTeam(teams, { profileId = null, espnTeamId = null }) {
  if (espnTeamId != null) {
    const hit = teams.find((t) => t.espn_team_id === espnTeamId)
    if (hit) return hit
  }
  if (profileId) {
    const hit = teams.find((t) => t.profile_id === profileId)
    if (hit) return hit
  }
  return null
}

const partiesOf = (trade, teams) => ({
  from: findTeam(teams, { profileId: trade.proposer_id }),
  to: findTeam(teams, {
    profileId: trade.receiver_id,
    espnTeamId: trade.receiver_espn_team_id,
  }),
})

/**
 * FAAB remaining per team key.
 *
 * budget − what ESPN says you already spent on waivers, then ± FAAB moved by
 * trades this app has COMPLETED. Pending and accepted trades are deliberately
 * excluded: money that might still be vetoed has not moved.
 *
 * ⚠️ Double-count risk. If your league also processes the trade inside ESPN,
 * ESPN's acquisitionBudgetSpent will eventually reflect it too. This is why
 * only completed trades count, and why the UI labels the number as derived.
 */
export function deriveFaab({ teams, trades = [], budget = 100 }) {
  const out = {}
  for (const t of teams) {
    out[t.key] = {
      budget,
      spent: t.faab_spent ?? 0,
      traded: 0,
      remaining: budget - (t.faab_spent ?? 0),
      known: t.faab_spent != null,
    }
  }

  for (const trade of trades) {
    if (trade.status !== 'completed') continue
    const { from, to } = partiesOf(trade, teams)
    if (!from || !to) continue
    for (const item of trade.trade_items ?? []) {
      if (item.item_type !== 'faab') continue
      const amt = Number(item.faab_amount) || 0
      // side A leaves the proposer, side B leaves the receiver
      const [giver, taker] = item.side === 'A' ? [from, to] : [to, from]
      if (out[giver.key]) { out[giver.key].traded -= amt; out[giver.key].remaining -= amt }
      if (out[taker.key]) { out[taker.key].traded += amt; out[taker.key].remaining += amt }
    }
  }
  return out
}

/**
 * Draft picks held per team key.
 *
 * Every team starts owning its own pick in each round of each tradeable year.
 * Completed trades move them. A pick is identified by
 * (year, round, original owner) — that triple is what makes "their 2027 3rd"
 * distinct from "my 2027 3rd" when both are in flight.
 *
 * A pick asset with no original owner recorded is assumed to be the SENDER's
 * own pick, which is what people mean when they don't specify.
 */
export function derivePicks({ teams, trades = [], rounds = 12, years = PICK_YEARS }) {
  const owner = new Map()          // pickId -> team key
  const pickId = (year, round, originKey) => `${year}|${round}|${originKey}`

  for (const t of teams) {
    for (const year of years) {
      for (let r = 1; r <= rounds; r++) owner.set(pickId(year, r, t.key), t.key)
    }
  }

  const ordered = [...trades]
    .filter((t) => t.status === 'completed')
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))

  for (const trade of ordered) {
    const { from, to } = partiesOf(trade, teams)
    if (!from || !to) continue
    for (const item of trade.trade_items ?? []) {
      if (item.item_type !== 'pick') continue
      const [giver, taker] = item.side === 'A' ? [from, to] : [to, from]

      const originTeam = findTeam(teams, {
        profileId: item.pick_original_owner_id,
        espnTeamId: item.pick_original_espn_team_id,
      }) ?? giver
      const id = pickId(item.pick_year, item.pick_round, originTeam.key)

      // Only move a pick that exists in the tradeable window. A trade naming
      // 2029 when PICK_YEARS stops at 2028 should not invent one.
      if (owner.has(id)) owner.set(id, taker.key)
    }
  }

  const byTeam = {}
  for (const t of teams) byTeam[t.key] = []
  const nameFor = (key) => teams.find((t) => t.key === key)?.team_name ?? 'Unknown'

  for (const [id, holder] of owner) {
    if (!byTeam[holder]) continue
    const [year, round, ...originParts] = id.split('|')
    const originKey = originParts.join('|')
    byTeam[holder].push({
      year: Number(year),
      round: Number(round),
      originKey,
      own: originKey === holder,
      originName: nameFor(originKey),
    })
  }

  for (const list of Object.values(byTeam)) {
    list.sort((a, b) => a.year - b.year || a.round - b.round || a.originName.localeCompare(b.originName))
  }
  return byTeam
}

// Trades that have already committed a pick. An accepted-but-not-completed
// trade has still spent it, and a pending one has still promised it — counting
// only completed trades would let a manager promise the same pick five times.
const COMMITTING = new Set(['pending', 'accepted', 'completed'])

/**
 * How many of its OWN picks a team has traded away.
 *
 * Enforces the league's three-pick limit. Picks the team ACQUIRED from someone
 * else are not counted — the rule caps how much of your own draft you can sell,
 * not how many picks pass through your hands.
 *
 * `excludeTradeId` lets a trade be re-checked without counting itself.
 */
export function ownPicksTradedAway({ teams, trades = [], teamKey, excludeTradeId = null }) {
  let n = 0
  for (const trade of trades) {
    if (!COMMITTING.has(trade.status)) continue
    if (excludeTradeId && trade.id === excludeTradeId) continue
    const { from, to } = partiesOf(trade, teams)
    if (!from || !to) continue
    for (const item of trade.trade_items ?? []) {
      if (item.item_type !== 'pick') continue
      const giver = item.side === 'A' ? from : to
      if (giver.key !== teamKey) continue
      const origin = findTeam(teams, {
        profileId: item.pick_original_owner_id,
        espnTeamId: item.pick_original_espn_team_id,
      }) ?? giver
      if (origin.key === teamKey) n++
    }
  }
  return n
}

/** "1st, 2nd, 3rd (from Bandits), 5th" for one year. */
export function summarisePicks(picks, year) {
  const mine = picks.filter((p) => p.year === year)
  if (mine.length === 0) return 'None'
  return mine
    .map((p) => (p.own ? ordinal(p.round) : `${ordinal(p.round)} (${p.originName})`))
    .join(', ')
}

export function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd']
  const v = n % 100
  return n + (s[(v - 20) % 10] ?? s[v] ?? s[0])
}
