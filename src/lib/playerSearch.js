/**
 * Player typeahead matching. Pure, and deliberately in its own module so it can
 * be tested without importing supabaseClient (which throws at import time when
 * the env vars are absent).
 */

/** Pre-lowercase once, so keystroke filtering is a substring test. */
export function indexPlayers(players) {
  return players.map((p) => ({ ...p, _s: `${p.name} ${p.pro_team ?? ''}`.toLowerCase() }))
}

/**
 * @param indexed  output of indexPlayers()
 * @param query    raw user input
 * @param limit    max rows to return
 * @param ids      optional Set of espn_id to restrict to — the trade builder
 *                 passes a team's roster so a side can only offer players that
 *                 team actually owns. Null means the whole league universe.
 *
 * Prefix matches rank above substring matches: typing "ja" should surface
 * Ja'Marr Chase before Kyle Ja*m*es.
 */
export function searchPlayers(indexed, query, limit = 8, ids = null) {
  const pool = ids ? indexed.filter((p) => ids.has(p.espn_id)) : indexed
  const q = (query ?? '').trim().toLowerCase()
  if (!q) return pool.slice(0, limit)

  const starts = []
  const contains = []
  for (const p of pool) {
    if (p._s.startsWith(q)) starts.push(p)
    else if (p._s.includes(q)) contains.push(p)
    if (starts.length >= limit) break
  }
  return [...starts, ...contains].slice(0, limit)
}
