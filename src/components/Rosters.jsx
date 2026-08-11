import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Users, AlertTriangle, Database, RefreshCw, Wallet, Layers, UserCheck, UserPlus,
} from 'lucide-react'
import { supabase } from '../supabaseClient'
import { usePlayers, invalidatePlayers } from '../lib/usePlayers'
import { deriveFaab, derivePicks, summarisePicks } from '../lib/teams'
import { PICK_YEARS } from '../lib/constants'
import { Badge, Card, EmptyState, IconButton, Loading, Select, cx } from './ui'

const POS_CHIP = {
  QB: 'bg-rose-500/15 text-rose-300 ring-rose-500/30',
  RB: 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/30',
  WR: 'bg-sky-500/15 text-sky-300 ring-sky-500/30',
  TE: 'bg-amber-500/15 text-amber-300 ring-amber-500/30',
  K: 'bg-purple-500/15 text-purple-300 ring-purple-500/30',
  'D/ST': 'bg-slate-500/15 text-slate-300 ring-slate-500/30',
}
const POS_ORDER = ['QB', 'RB', 'WR', 'TE', 'K', 'D/ST']
const isHurt = (s) => s && s !== 'ACTIVE' && s !== 'NORMAL'

export default function Rosters({ league, teams, toast, refreshKey }) {
  const players = usePlayers(league.id)
  const [rosters, setRosters] = useState([])
  const [trades, setTrades] = useState([])
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState('all')

  const load = useCallback(async () => {
    setLoading(true)
    // Trades come along because FAAB and pick ownership are DERIVED from
    // completed ones — there is no stored "picks you own" table to read.
    const [rostersRes, tradesRes] = await Promise.all([
      supabase.from('espn_rosters').select('*').eq('league_id', league.id),
      supabase.from('trades').select('*, trade_items(*)').eq('league_id', league.id),
    ])
    if (rostersRes.error) toast.error(rostersRes.error.message)
    if (tradesRes.error) toast.error(tradesRes.error.message)

    // Newest synced season only. Mixing seasons doubles every kept player.
    const all = rostersRes.data ?? []
    const latest = all.length ? Math.max(...all.map((r) => r.season)) : null
    setRosters(all.filter((r) => r.season === latest))
    setTrades(tradesRes.data ?? [])
    setLoading(false)
  }, [toast, league.id])

  useEffect(() => { load() }, [load, refreshKey])

  const playerById = useMemo(
    () => Object.fromEntries(players.players.map((p) => [p.espn_id, p])),
    [players.players]
  )

  const byTeam = useMemo(() => {
    const map = {}
    for (const r of rosters) (map[r.espn_team_id] ??= []).push(r)
    for (const list of Object.values(map)) {
      list.sort((a, b) => {
        const pa = playerById[a.espn_player_id]
        const pb = playerById[b.espn_player_id]
        const oa = POS_ORDER.indexOf(pa?.position ?? '')
        const ob = POS_ORDER.indexOf(pb?.position ?? '')
        if (oa !== ob) return (oa < 0 ? 99 : oa) - (ob < 0 ? 99 : ob)
        return (pa?.espn_rank ?? 9999) - (pb?.espn_rank ?? 9999)
      })
    }
    return map
  }, [rosters, playerById])

  const faab = useMemo(
    () => deriveFaab({ teams, trades, budget: league.faab_budget ?? 100 }),
    [teams, trades, league.faab_budget]
  )
  const picks = useMemo(
    () => derivePicks({ teams, trades, rounds: league.draft_rounds ?? 12 }),
    [teams, trades, league.draft_rounds]
  )

  const shownTeams = selected === 'all' ? teams : teams.filter((t) => t.key === selected)
  const claimedCount = teams.filter((t) => t.claimed).length

  if (loading || players.loading) return <Loading label="Loading teams…" />

  if (teams.length === 0) {
    return (
      <Card>
        <EmptyState icon={Database} title="No teams yet">
          Your commissioner needs to connect ESPN and run a sync from
          <span className="text-slate-400"> League Settings</span>. Credentials are stored
          write-only and used only by the server-side sync function.
        </EmptyState>
      </Card>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-black tracking-tight text-slate-100">Teams</h2>
          <p className="text-sm text-slate-500">
            {claimedCount} of {teams.length} registered · FAAB and picks are derived from
            completed trades.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Select
            className="w-auto"
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
            aria-label="Filter by team"
          >
            <option value="all">All teams</option>
            {teams.map((t) => (
              <option key={t.key} value={t.key}>{t.team_name}</option>
            ))}
          </Select>
          <IconButton label="Refresh" onClick={() => { invalidatePlayers(league.id); load() }}>
            <RefreshCw className="h-4 w-4" />
          </IconButton>
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        {shownTeams.map((team) => {
          const list = team.espn_team_id != null ? byTeam[team.espn_team_id] ?? [] : []
          const money = faab[team.key]
          const held = picks[team.key] ?? []

          return (
            <Card key={team.key} className="overflow-hidden">
              <div className="flex items-center justify-between gap-2 border-b border-slate-800 px-4 py-2.5">
                <div className="flex min-w-0 items-center gap-2">
                  <Users className="h-4 w-4 shrink-0 text-slate-500" aria-hidden />
                  <h3 className="truncate text-sm font-bold text-slate-100">{team.team_name}</h3>
                  {team.claimed ? (
                    <Badge className="shrink-0 bg-emerald-500/15 text-emerald-300 ring-emerald-500/30">
                      <UserCheck className="h-3 w-3" aria-hidden /> Registered
                    </Badge>
                  ) : (
                    <Badge className="shrink-0 bg-slate-500/15 text-slate-400 ring-slate-500/30">
                      <UserPlus className="h-3 w-3" aria-hidden /> Invite pending
                    </Badge>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {team.wins != null && (
                    <span className="text-xs text-slate-500">{team.wins}-{team.losses}</span>
                  )}
                  <span className="text-xs text-slate-600">{list.length}</span>
                </div>
              </div>

              {/* FAAB + picks ------------------------------------------------ */}
              <div className="grid gap-px border-b border-slate-800 bg-slate-800 sm:grid-cols-2">
                <div className="bg-slate-900/60 px-4 py-2.5">
                  <p className="mb-0.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                    <Wallet className="h-3 w-3" aria-hidden /> FAAB left
                  </p>
                  <p className="text-sm font-bold text-emerald-300">
                    ${money?.remaining ?? league.faab_budget ?? 100}
                    <span className="ml-1 text-xs font-normal text-slate-500">
                      of ${money?.budget ?? league.faab_budget ?? 100}
                    </span>
                  </p>
                  <p className="text-[11px] text-slate-600">
                    {money?.known
                      ? `$${money.spent} spent on waivers`
                      : 'waiver spend not synced'}
                    {money?.traded ? ` · ${money.traded > 0 ? '+' : ''}$${money.traded} traded` : ''}
                  </p>
                </div>

                <div className="bg-slate-900/60 px-4 py-2.5">
                  <p className="mb-0.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                    <Layers className="h-3 w-3" aria-hidden /> Draft picks
                  </p>
                  {PICK_YEARS.map((year) => (
                    <p key={year} className="text-[11px] leading-relaxed text-slate-400">
                      <span className="font-semibold text-slate-300">{year}</span>{' '}
                      <span className={cx(
                        summarisePicks(held, year) === 'None' && 'text-slate-600'
                      )}>
                        {summarisePicks(held, year)}
                      </span>
                    </p>
                  ))}
                </div>
              </div>

              {list.length === 0 ? (
                <p className="px-4 py-4 text-center text-xs text-slate-600">
                  {team.espn_team_id == null
                    ? 'Not linked to an ESPN team yet'
                    : 'No players synced'}
                </p>
              ) : (
                <ul className="divide-y divide-slate-800/60">
                  {list.map((r) => {
                    const p = playerById[r.espn_player_id]
                    return (
                      <li key={r.id} className="flex items-center gap-2 px-4 py-1.5 text-sm">
                        <Badge className={cx('w-11 justify-center', POS_CHIP[p?.position] ?? POS_CHIP['D/ST'])}>
                          {p?.position ?? '—'}
                        </Badge>
                        <span className="min-w-0 flex-1 truncate text-slate-200">
                          {/* No matching player row means the sync trimmed him
                              past TAIL_LIMIT — show the id, not a blank line. */}
                          {p?.name ?? `ESPN #${r.espn_player_id}`}
                        </span>
                        {isHurt(p?.injury_status) && (
                          <AlertTriangle className="h-3 w-3 shrink-0 text-amber-400" aria-label={p.injury_status} />
                        )}
                        <span className="shrink-0 text-xs text-slate-500">{p?.pro_team}</span>
                        {r.lineup_slot === 'Bench' || r.lineup_slot === 'IR' ? (
                          <span className="shrink-0 text-[10px] uppercase text-slate-600">{r.lineup_slot}</span>
                        ) : null}
                      </li>
                    )
                  })}
                </ul>
              )}
            </Card>
          )
        })}
      </div>
    </div>
  )
}
