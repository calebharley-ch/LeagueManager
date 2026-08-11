/**
 * sync-espn — pull ESPN league data using credentials the commissioner stored.
 *
 * Deploy:  supabase functions deploy sync-espn
 * Call:    supabase.functions.invoke('sync-espn', { body: { league_id } })
 *
 * ⚠️ THIS EXISTS SO THE CREDENTIALS NEVER REACH A BROWSER.
 *
 * ESPN_S2 and SWID are session cookies for a real ESPN account, not scoped
 * tokens. `league_espn_credentials` has NO select policy, so no client can read
 * them back — only this function can, via the service_role key, and it runs on
 * Supabase's servers. It also sidesteps ESPN's missing CORS headers, which
 * would block a browser fetch outright.
 *
 * Two distinct clients below, and mixing them up is the whole ballgame:
 *   userClient    - carries the CALLER's JWT, subject to RLS. Used only to
 *                   establish who they are and that they run this league.
 *   serviceClient - bypasses RLS entirely. Used to read credentials and write
 *                   the synced rows. Never accepts anything caller-controlled
 *                   except the league id we already authorised above.
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const POS_MAP: Record<number, string> = { 1: 'QB', 2: 'RB', 3: 'WR', 4: 'TE', 5: 'K', 16: 'D/ST' }

const TEAM_MAP: Record<number, string> = {
  0: 'FA', 1: 'ATL', 2: 'BUF', 3: 'CHI', 4: 'CIN', 5: 'CLE', 6: 'DAL', 7: 'DEN',
  8: 'DET', 9: 'GB', 10: 'TEN', 11: 'IND', 12: 'KC', 13: 'LV', 14: 'LAR', 15: 'MIA',
  16: 'MIN', 17: 'NE', 18: 'NO', 19: 'NYG', 20: 'NYJ', 21: 'PHI', 22: 'ARI', 23: 'PIT',
  24: 'LAC', 25: 'SF', 26: 'SEA', 27: 'TB', 28: 'WSH', 29: 'CAR', 30: 'JAX', 33: 'BAL', 34: 'HOU',
}

const SLOT_MAP: Record<number, string> = {
  0: 'QB', 2: 'RB', 4: 'WR', 6: 'TE', 16: 'D/ST', 17: 'K', 20: 'Bench', 21: 'IR', 23: 'FLEX',
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })

/* ── ESPN ─────────────────────────────────────────────────────────────────── */

async function espnGet(url: string, s2?: string, swid?: string, extra: Record<string, string> = {}) {
  const headers: Record<string, string> = {
    'User-Agent': 'Mozilla/5.0 (compatible; LeagueManager/1.0)',
    Accept: 'application/json',
    ...extra,
  }
  // Only send cookies when we have both. An empty Cookie header makes ESPN's
  // edge return 401 instead of the public payload.
  if (s2 && swid) {
    headers.Cookie = `espn_s2=${s2}; SWID=${swid.startsWith('{') ? swid : `{${swid}}`}`
  }

  const res = await fetch(url, { headers })
  if (!res.ok) {
    // ⚠️ NEVER include the response body in an auth error. ESPN sometimes
    // reflects request headers back, which would write the cookies into your
    // function logs.
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        'ESPN rejected the credentials (HTTP ' + res.status + '). They expire every ' +
        'few weeks — reconnect ESPN in League Settings with fresh cookies.'
      )
    }
    throw new Error(`ESPN returned HTTP ${res.status}`)
  }
  return res.json()
}

// ⚠️ MEASURED (season 2025). The X-Fantasy-Filter on THIS endpoint must be
// TOP-LEVEL. Nesting it under `players` — which is what league-scoped views
// want — makes ESPN ignore the whole thing:
//
//   nested    {players:{limit:50}}  -> 21.60 MB, 2876 rows, first = Curtis Hodges
//   top-level {limit:50}            ->  0.90 MB,   50 rows, first = Ja'Marr Chase
//
// The nested form is what returned WORKER_RESOURCE_LIMIT (HTTP 546): a 21.6 MB
// JSON.parse blows the edge worker's memory/CPU ceiling. An earlier comment
// here claimed limit and sort were simply "ignored by this endpoint" — that was
// wrong, and it was wrong because the probe used the nested shape too.
//
// kona_player_info carries full stat splits, so it scales badly:
//   limit 300 -> 4.95 MB | limit 600 -> 9.17 MB | limit 1000 -> 13.50 MB
//
// Hence two calls rather than one big one:
//   DETAIL  kona_player_info, top 500 (~7.9 MB) — draft ranks, ADP, auction
//           value, injury status. The players anyone actually trades.
//   TAIL    players_wl, 3000 rows (~0.6 MB) — name, position, pro team, %owned
//           and nothing else, but sorted the same way. Exists so a deep bench
//           stash on someone's roster still resolves to a name.
//
// Measured end to end: 8.47 MB fetched, 38 MB peak heap, 1196 unique offensive
// players, 354 of them with a real draft rank. ~30% of any DETAIL page is IDP
// that POS_MAP discards, which is why 500 in yields ~354 usable.
// TAIL_LIMIT is deliberately above the 2876-row universe so it returns all of
// it; raising it further does nothing.
const DETAIL_LIMIT = 500
const TAIL_LIMIT = 3000

async function fetchPlayers(season: number, s2?: string, swid?: string) {
  const base =
    `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl` +
    `/seasons/${season}/players?scoringPeriodId=0&view=`
  const sort = { sortDraftRanks: { sortPriority: 1, sortAsc: true, value: 'PPR' } }

  const detail = await espnGet(base + 'kona_player_info', s2, swid, {
    'X-Fantasy-Filter': JSON.stringify({ limit: DETAIL_LIMIT, ...sort }),
  })

  // Breadth is a nice-to-have. If it fails, the top of the board still syncs.
  let tail: any[] = []
  try {
    tail = await espnGet(base + 'players_wl', s2, swid, {
      'X-Fantasy-Filter': JSON.stringify({ limit: TAIL_LIMIT, ...sort }),
    })
  } catch (_) { /* ignore */ }

  return { detail: (detail ?? []) as any[], tail: (tail ?? []) as any[] }
}

async function fetchLeague(espnLeagueId: string, season: number, s2?: string, swid?: string) {
  // leagueHistory returns an ARRAY of seasons; the current-season endpoint
  // returns a bare object. Try history first, fall back for a live season.
  const historyUrl =
    `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl` +
    `/leagueHistory/${espnLeagueId}?seasonId=${season}&view=mTeam&view=mRoster&view=mSettings`
  try {
    const data = await espnGet(historyUrl, s2, swid)
    const league = Array.isArray(data) ? data[0] : data
    if (league?.teams?.length) return league
  } catch (_) { /* fall through */ }

  const liveUrl =
    `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl` +
    `/seasons/${season}/segments/0/leagues/${espnLeagueId}?view=mTeam&view=mRoster&view=mSettings`
  const data = await espnGet(liveUrl, s2, swid)
  return Array.isArray(data) ? data[0] : data
}

/* ── Transform ────────────────────────────────────────────────────────────── */

/**
 * Merge the detail and tail fetches into one deduplicated row set.
 *
 * ⚠️ The dedupe is not cosmetic. The two calls overlap almost entirely — the
 * top 400 appear in both — and Postgres rejects an upsert whose batch contains
 * the same conflict key twice ("ON CONFLICT DO UPDATE command cannot affect row
 * a second time"). Keying a Map by espn_id is what prevents that.
 *
 * Tail rows are written first so detail rows overwrite them; a detail row has
 * ranks and injury status, a tail row has nulls there.
 */
function parsePlayers(
  raw: { detail: any[]; tail: any[] },
  leagueId: string,
  season: number,
) {
  const now = new Date().toISOString()
  const round2 = (v: unknown) => (typeof v === 'number' ? Math.round(v * 100) / 100 : null)
  const byId = new Map<number, Record<string, unknown>>()

  const add = (p: any) => {
    const pos = POS_MAP[p.defaultPositionId]
    if (!pos || p.id == null) return           // skip IDP and slots we don't use
    const ranks = p.draftRanksByRankType ?? {}
    const ppr = ranks.PPR ?? {}
    const std = ranks.STANDARD ?? {}
    const own = p.ownership ?? {}
    byId.set(p.id, {
      league_id: leagueId,
      espn_id: p.id,
      season,
      name: p.fullName ?? '',
      position: pos,
      pro_team: TEAM_MAP[p.proTeamId ?? 0] ?? 'FA',
      injury_status: p.injuryStatus ?? null,
      espn_rank: ppr.rank ?? std.rank ?? null,
      adp: round2(own.averageDraftPosition),
      pct_owned: round2(own.percentOwned),
      auction_value: ppr.auctionValue ?? std.auctionValue ?? null,
      updated_at: now,
    })
  }

  for (const p of raw.tail ?? []) add(p)
  for (const p of raw.detail ?? []) add(p)

  const out = [...byId.values()]
  out.sort((a, b) => ((a.espn_rank as number) ?? 1e9) - ((b.espn_rank as number) ?? 1e9))
  return out
}

function parseLeague(league: any, leagueId: string, season: number) {
  const now = new Date().toISOString()
  const teams = []
  const rosters = []

  // FAAB. `mSettings` carries the league-wide budget, `mTeam` the per-team
  // spend. Both are optional — a league that drafts without a waiver budget
  // reports neither, and null is the honest answer there rather than 0.
  const budget = league?.settings?.acquisitionSettings?.acquisitionBudget ?? null
  const faabBudget = typeof budget === 'number' && budget > 0 ? budget : null

  for (const t of league?.teams ?? []) {
    // ESPN moved this across seasons: older payloads use location + nickname,
    // newer ones a flat `name`.
    const name = t.name ?? [t.location, t.nickname].filter(Boolean).join(' ').trim()
    teams.push({
      league_id: leagueId,
      espn_team_id: t.id,
      season,
      team_name: name || `Team ${t.id}`,
      owner_name: t.primaryOwner ?? null,
      wins: t.record?.overall?.wins ?? null,
      losses: t.record?.overall?.losses ?? null,
      faab_spent: typeof t.transactionCounter?.acquisitionBudgetSpent === 'number'
        ? t.transactionCounter.acquisitionBudgetSpent
        : null,
      updated_at: now,
    })
    for (const e of t.roster?.entries ?? []) {
      rosters.push({
        league_id: leagueId,
        season,
        espn_team_id: t.id,
        espn_player_id: e.playerId,
        lineup_slot: SLOT_MAP[e.lineupSlotId] ?? String(e.lineupSlotId),
        acquired_type: e.acquisitionType ?? null,
        updated_at: now,
      })
    }
  }
  return { teams, rosters, faabBudget }
}

/* ── Handler ──────────────────────────────────────────────────────────────── */

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
  const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!
  const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

  let leagueId = ''
  const serviceClient = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false },
  })

  try {
    const body = await req.json().catch(() => ({}))
    leagueId = body.league_id ?? ''
    const seasonOverride = body.season ? Number(body.season) : null
    if (!leagueId) return json({ error: 'league_id is required' }, 400)

    // ── Who is calling? ──────────────────────────────────────────────────────
    const authHeader = req.headers.get('Authorization') ?? ''
    if (!authHeader) return json({ error: 'Missing Authorization header' }, 401)

    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false },
    })
    const { data: { user }, error: userErr } = await userClient.auth.getUser()
    if (userErr || !user) return json({ error: 'Not authenticated' }, 401)

    // ── Are they the commissioner OF THIS LEAGUE? ────────────────────────────
    // Checked with the SERVICE client against the caller's real id. Asking the
    // user client would work too, but this keeps the authorisation decision
    // independent of whatever RLS happens to allow today.
    const { data: membership } = await serviceClient
      .from('league_members')
      .select('role')
      .eq('league_id', leagueId)
      .eq('profile_id', user.id)
      .maybeSingle()

    if (!membership) return json({ error: 'You are not a member of this league' }, 403)
    if (membership.role !== 'commissioner') {
      return json({ error: 'Only the commissioner can sync ESPN data' }, 403)
    }

    // ── League config ────────────────────────────────────────────────────────
    const { data: league, error: leagueErr } = await serviceClient
      .from('leagues')
      .select('espn_league_id, season')
      .eq('id', leagueId)
      .single()
    if (leagueErr || !league) return json({ error: 'League not found' }, 404)
    if (!league.espn_league_id) {
      return json({ error: 'Set the ESPN league id in League Settings first.' }, 400)
    }
    const season = seasonOverride ?? league.season

    // ── Credentials. Only reachable from here. ───────────────────────────────
    const { data: creds } = await serviceClient
      .from('league_espn_credentials')
      .select('espn_s2, swid')
      .eq('league_id', leagueId)
      .maybeSingle()

    // Public leagues sync fine without them, so this is not fatal.
    const s2 = creds?.espn_s2 ?? undefined
    const swid = creds?.swid ?? undefined

    // ── Players ──────────────────────────────────────────────────────────────
    const rawPlayers = await fetchPlayers(season, s2, swid)
    const players = parsePlayers(rawPlayers, leagueId, season)

    const CHUNK = 500
    for (let i = 0; i < players.length; i += CHUNK) {
      const { error } = await serviceClient
        .from('espn_players')
        .upsert(players.slice(i, i + CHUNK), { onConflict: 'league_id,espn_id,season' })
      if (error) throw new Error(`espn_players: ${error.message}`)
    }

    // ── Teams + rosters (best effort) ────────────────────────────────────────
    let teamCount = 0
    let rosterCount = 0
    let rosterWarning: string | null = null
    try {
      const raw = await fetchLeague(league.espn_league_id, season, s2, swid)
      const { teams, rosters, faabBudget } = parseLeague(raw, leagueId, season)

      // Only overwrite when ESPN actually reported a budget. A league that does
      // not use FAAB would otherwise reset the commissioner's manual value to 0
      // on every sync.
      if (faabBudget != null) {
        await serviceClient.from('leagues')
          .update({ faab_budget: faabBudget }).eq('id', leagueId)
      }

      if (teams.length) {
        const { error } = await serviceClient
          .from('espn_teams')
          .upsert(teams, { onConflict: 'league_id,espn_team_id,season' })
        if (error) throw new Error(`espn_teams: ${error.message}`)
        teamCount = teams.length
      }
      for (let i = 0; i < rosters.length; i += CHUNK) {
        const { error } = await serviceClient
          .from('espn_rosters')
          .upsert(rosters.slice(i, i + CHUNK),
                  { onConflict: 'league_id,season,espn_team_id,espn_player_id' })
        if (error) throw new Error(`espn_rosters: ${error.message}`)
      }
      rosterCount = rosters.length
    } catch (err) {
      // A private league without valid cookies still gets a full player
      // universe, which is what the trade builder needs. Don't fail the run.
      rosterWarning = err instanceof Error ? err.message : String(err)
    }

    const status = rosterWarning
      ? `${players.length} players synced; rosters skipped — ${rosterWarning}`
      : `${players.length} players, ${teamCount} teams, ${rosterCount} roster slots`

    await serviceClient.from('leagues')
      .update({ last_sync_at: new Date().toISOString(), last_sync_status: status })
      .eq('id', leagueId)

    await serviceClient.from('audit_log').insert({
      league_id: leagueId,
      actor_id: user.id,
      action: 'league.espn_synced',
      entity_type: 'league',
      entity_id: leagueId,
      details: { players: players.length, teams: teamCount, rosters: rosterCount, season },
    })

    return json({
      ok: true, season,
      players: players.length, teams: teamCount, rosters: rosterCount,
      warning: rosterWarning,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (leagueId) {
      await serviceClient.from('leagues')
        .update({ last_sync_at: new Date().toISOString(), last_sync_status: `Failed — ${message}` })
        .eq('id', leagueId)
    }
    return json({ error: message }, 500)
  }
})
