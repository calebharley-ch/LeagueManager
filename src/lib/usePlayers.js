import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '../supabaseClient'
import { indexPlayers, searchPlayers } from './playerSearch'

// Per-league cache. The player universe is ~1200 rows that change once a week
// at most, and the trade builder mounts a PlayerPicker per asset row — refetching
// on every mount would be pure waste.
const cache = new Map()      // leagueId -> { season, players }
const inflight = new Map()

async function fetchPlayers(leagueId) {
  if (cache.has(leagueId)) return cache.get(leagueId)
  if (inflight.has(leagueId)) return inflight.get(leagueId)

  const p = (async () => {
    // Newest synced season wins, so the app follows the sync without carrying
    // its own idea of "current season".
    const { data: seasonRow, error: seasonErr } = await supabase
      .from('espn_players')
      .select('season')
      .eq('league_id', leagueId)
      .order('season', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (seasonErr) throw seasonErr
    if (!seasonRow) return { season: null, players: [] }

    const { data, error } = await supabase
      .from('espn_players')
      .select('espn_id, name, position, pro_team, injury_status, espn_rank, adp, pct_owned')
      .eq('league_id', leagueId)
      .eq('season', seasonRow.season)
      // nullsFirst:false — Postgres puts NULLs first on ASC by default, which
      // would bury every ranked player under the unranked ones.
      .order('espn_rank', { ascending: true, nullsFirst: false })
      .limit(3000)
    if (error) throw error

    const result = { season: seasonRow.season, players: data ?? [] }
    cache.set(leagueId, result)
    return result
  })()

  inflight.set(leagueId, p)
  try { return await p } finally { inflight.delete(leagueId) }
}

/** Force the next read to hit the network. Call after a sync. */
export function invalidatePlayers(leagueId) {
  if (leagueId) cache.delete(leagueId)
  else cache.clear()
}

/**
 * The league's ESPN player universe.
 * Returns { players, season, loading, error, search(query, limit) }.
 *
 * `error` is not fatal to callers: every consumer falls back to free-text, so a
 * league that has never synced still works.
 */
export function usePlayers(leagueId) {
  const [state, setState] = useState(() => {
    const hit = leagueId && cache.get(leagueId)
    return hit
      ? { players: hit.players, season: hit.season, loading: false, error: null }
      : { players: [], season: null, loading: Boolean(leagueId), error: null }
  })

  useEffect(() => {
    if (!leagueId) { setState({ players: [], season: null, loading: false, error: null }); return }
    const hit = cache.get(leagueId)
    if (hit) { setState({ ...hit, loading: false, error: null }); return }

    let alive = true
    setState((s) => ({ ...s, loading: true }))
    fetchPlayers(leagueId)
      .then((res) => alive && setState({ ...res, loading: false, error: null }))
      .catch((err) => alive && setState({ players: [], season: null, loading: false, error: err.message }))
    return () => { alive = false }
  }, [leagueId])

  // Pre-lowercased once so keystroke filtering is a substring test rather than
  // ~1200 toLowerCase() calls per character typed.
  const indexed = useMemo(() => indexPlayers(state.players), [state.players])

  // Matching lives in lib/playerSearch so it can be unit tested — this module
  // imports supabaseClient, which throws at import time without env vars.
  const search = useCallback(
    (query, limit = 8, ids = null) => searchPlayers(indexed, query, limit, ids),
    [indexed]
  )

  return { ...state, search }
}
