import { useCallback, useEffect, useMemo, useState } from 'react'
import { Trophy, Crown, TrendingUp, Swords, Table2, ChevronDown, History as HistoryIcon } from 'lucide-react'
import { supabase } from '../supabaseClient'
import { ACCENT, ACCENT_SOFT } from '../lib/chartTheme'
import ChartCanvas from './ChartCanvas'
import { Badge, Card, EmptyState, Loading, cx } from './ui'

/**
 * The league's record: who has won it, who scores, who owns whom.
 *
 * Read-only and hand-curated — see migration 013. Everything lives in one
 * `league_history` row set keyed by `kind`, fetched once and rendered from
 * memory, because it changes about once a season.
 *
 * Headline numbers are always visible; the three big tables are behind
 * disclosures, since they are reference material rather than something you
 * scan every visit.
 */

const KINDS = ['dynasty', 'champions', 'standings', 'pf_by_year', 'h2h', 'core', 'palette']

/** Collapsible section. Closed by default — this is drill-down, not headline. */
function Drawer({ icon: Icon, title, subtitle, children }) {
  const [open, setOpen] = useState(false)
  return (
    <Card className="overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-slate-800/40"
      >
        <Icon className="h-4 w-4 shrink-0 text-slate-500" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-bold text-slate-100">{title}</p>
          {subtitle && <p className="truncate text-xs text-slate-500">{subtitle}</p>}
        </div>
        <ChevronDown
          className={cx('h-4 w-4 shrink-0 text-slate-500 transition-transform', open && 'rotate-180')}
          aria-hidden
        />
      </button>
      {open && <div className="border-t border-slate-800">{children}</div>}
    </Card>
  )
}

const num = (v, d = 0) =>
  typeof v === 'number' ? v.toLocaleString(undefined, { maximumFractionDigits: d }) : v

export default function History({ league, toast }) {
  const [rows, setRows] = useState(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    const { data, error } = await supabase
      .from('league_history')
      .select('kind, payload')
      .eq('league_id', league.id)
    if (error) toast.error(error.message)
    setRows(Object.fromEntries((data ?? []).map((r) => [r.kind, r.payload])))
    setLoading(false)
  }, [league.id, toast])

  useEffect(() => { load() }, [load])

  const d = rows ?? {}
  const dynasty = d.dynasty ?? []
  const champions = d.champions ?? []
  const standings = d.standings ?? {}
  const pfByYear = d.pf_by_year ?? {}
  const h2h = d.h2h ?? {}
  const core = d.core ?? []
  const palette = d.palette ?? [ACCENT]

  const colourFor = useCallback(
    (name) => palette[Math.max(0, core.indexOf(name)) % palette.length] ?? ACCENT,
    [palette, core]
  )

  /* Championships, most first. */
  const champChart = useMemo(() => {
    const ranked = [...dynasty].filter((m) => m.champs > 0).sort((a, b) => b.champs - a.champs)
    return {
      data: {
        labels: ranked.map((m) => m.name),
        datasets: [{
          label: 'Championships',
          data: ranked.map((m) => m.champs),
          backgroundColor: ranked.map((m) => colourFor(m.name)),
          borderRadius: 4,
          borderWidth: 0,
        }],
      },
      options: {
        indexAxis: 'y',
        plugins: { legend: { display: false } },
        scales: {
          x: { beginAtZero: true, ticks: { stepSize: 1, precision: 0 } },
          y: { grid: { display: false } },
        },
      },
    }
  }, [dynasty, colourFor])

  /* Points for, per season, one line per active manager. */
  const years = useMemo(() => {
    const s = new Set()
    for (const byYear of Object.values(pfByYear)) Object.keys(byYear).forEach((y) => s.add(y))
    return [...s].sort()
  }, [pfByYear])

  const pfChart = useMemo(() => ({
    data: {
      labels: years,
      datasets: Object.entries(pfByYear).map(([name, byYear]) => ({
        label: name,
        data: years.map((y) => byYear[y] ?? null),
        borderColor: colourFor(name),
        backgroundColor: colourFor(name),
        borderWidth: 2,
        pointRadius: 2,
        pointHoverRadius: 4,
        tension: 0.3,
        spanGaps: true,
      })),
    },
    options: {
      interaction: { mode: 'nearest', intersect: false },
      scales: { y: { beginAtZero: false } },
    },
  }), [years, pfByYear, colourFor])

  /* Career wins. */
  const winChart = useMemo(() => {
    const ranked = [...dynasty].sort((a, b) => b.w - a.w)
    return {
      data: {
        labels: ranked.map((m) => m.name),
        datasets: [
          { label: 'Wins', data: ranked.map((m) => m.w), backgroundColor: ACCENT, borderRadius: 4 },
          { label: 'Losses', data: ranked.map((m) => m.l), backgroundColor: 'rgba(148,163,184,.35)', borderRadius: 4 },
        ],
      },
      options: {
        scales: {
          x: { stacked: true, grid: { display: false }, ticks: { maxRotation: 60, minRotation: 45 } },
          y: { stacked: true, beginAtZero: true },
        },
      },
    }
  }, [dynasty])

  const warLeader = useMemo(
    () => [...dynasty].sort((a, b) => (b.war ?? 0) - (a.war ?? 0))[0] ?? null,
    [dynasty]
  )
  const titleHolder = useMemo(
    () => [...champions].filter((c) => !c.preEspn).sort((a, b) => b.year - a.year)[0] ?? null,
    [champions]
  )

  if (loading) return <Loading label="Loading league history…" />

  if (!dynasty.length && !champions.length) {
    return (
      <Card>
        <EmptyState icon={HistoryIcon} title="No history recorded">
          Nothing has been added for this league yet. History is seeded by the
          commissioner — see <span className="text-slate-400">migrations/013_league_history.sql</span>.
        </EmptyState>
      </Card>
    )
  }

  const h2hNames = Object.keys(h2h)

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-black tracking-tight text-slate-100">League history</h2>
        <p className="text-sm text-slate-500">
          {champions.length} seasons on record · {dynasty.length} managers all time.
        </p>
      </div>

      {/* Headline numbers */}
      <div className="grid gap-3 sm:grid-cols-2">
        {titleHolder && (
          <Card className="flex items-center gap-3 p-4">
            <div className="rounded-xl bg-amber-500/10 p-2.5 ring-1 ring-amber-500/30">
              <Crown className="h-5 w-5 text-amber-400" aria-hidden />
            </div>
            <div className="min-w-0">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                Reigning champion
              </p>
              <p className="truncate text-base font-bold text-slate-100">{titleHolder.name}</p>
              <p className="truncate text-xs text-slate-500">
                {titleHolder.year}{titleHolder.team && titleHolder.team !== '—' ? ` · ${titleHolder.team}` : ''}
              </p>
            </div>
          </Card>
        )}
        {warLeader && (
          <Card className="flex items-center gap-3 p-4">
            <div className="rounded-xl bg-emerald-500/10 p-2.5 ring-1 ring-emerald-500/30">
              <TrendingUp className="h-5 w-5 text-emerald-400" aria-hidden />
            </div>
            <div className="min-w-0">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                Wins above replacement
              </p>
              <p className="truncate text-base font-bold text-slate-100">{warLeader.name}</p>
              <p className="truncate text-xs text-slate-500">
                {warLeader.war > 0 ? '+' : ''}{num(warLeader.war, 2)} · {warLeader.w}-{warLeader.l}
                {warLeader.t ? `-${warLeader.t}` : ''}
              </p>
            </div>
          </Card>
        )}
      </div>

      <Card className="p-4">
        <p className="mb-3 flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-slate-400">
          <Trophy className="h-3.5 w-3.5" aria-hidden /> Championships, all time
        </p>
        <ChartCanvas
          type="bar" {...champChart} height={Math.max(180, champChart.data.labels.length * 30)}
          label="Championships won by each manager"
        />
      </Card>

      <Card className="p-4">
        <p className="mb-3 flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-slate-400">
          <TrendingUp className="h-3.5 w-3.5" aria-hidden /> Points scored per season
        </p>
        <ChartCanvas type="line" {...pfChart} height={300} label="Points scored per season by manager" />
      </Card>

      <Card className="p-4">
        <p className="mb-3 flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-slate-400">
          <Swords className="h-3.5 w-3.5" aria-hidden /> Career record
        </p>
        <ChartCanvas type="bar" {...winChart} height={300} label="Career wins and losses by manager" />
      </Card>

      {/* Drill-downs */}
      <Drawer
        icon={Table2}
        title="All-time table"
        subtitle={`${dynasty.length} managers · record, points, playoffs, titles`}
      >
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="border-b border-slate-800 text-left text-[11px] uppercase tracking-wide text-slate-500">
                <th className="px-4 py-2 font-semibold">Manager</th>
                <th className="px-3 py-2 font-semibold">Record</th>
                <th className="px-3 py-2 text-right font-semibold">PF</th>
                <th className="px-3 py-2 text-right font-semibold">PA</th>
                <th className="px-3 py-2 text-right font-semibold">Playoffs</th>
                <th className="px-3 py-2 text-right font-semibold">Titles</th>
                <th className="px-3 py-2 text-right font-semibold">WAR</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60">
              {[...dynasty].sort((a, b) => b.champs - a.champs || b.w - a.w).map((m) => (
                <tr key={m.name} className="text-slate-300">
                  <td className="px-4 py-2 font-semibold text-slate-100">{m.name}</td>
                  <td className="px-3 py-2 tabular-nums">
                    {m.w}-{m.l}{m.t ? `-${m.t}` : ''}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{num(m.pf)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{num(m.pa)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{m.playoffs}</td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {m.champs > 0
                      ? <Badge className="bg-amber-500/15 text-amber-300 ring-amber-500/30">{m.champs}</Badge>
                      : <span className="text-slate-600">—</span>}
                  </td>
                  <td className={cx(
                    'px-3 py-2 text-right tabular-nums font-semibold',
                    m.war > 0 ? 'text-emerald-400' : m.war < 0 ? 'text-rose-400' : 'text-slate-500'
                  )}>
                    {m.war > 0 ? '+' : ''}{num(m.war, 2)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Drawer>

      <Drawer icon={Crown} title="Champions" subtitle={`Every season back to ${champions.at(-1)?.year ?? ''}`}>
        <ul className="divide-y divide-slate-800/60">
          {[...champions].sort((a, b) => b.year - a.year).map((c) => (
            <li key={c.year} className="flex items-center gap-3 px-4 py-2 text-sm">
              <span className="w-12 shrink-0 font-mono text-xs text-slate-500">{c.year}</span>
              <span className="min-w-0 flex-1 truncate font-semibold text-slate-100">{c.name}</span>
              <span className="hidden truncate text-xs text-slate-500 sm:block">{c.team}</span>
              <span className="shrink-0 font-mono text-xs text-slate-500">{c.record}</span>
            </li>
          ))}
        </ul>
      </Drawer>

      <Drawer icon={Table2} title="Final standings by season" subtitle={`${Object.keys(standings).length} seasons`}>
        <div className="space-y-4 px-4 py-3">
          {Object.keys(standings).sort((a, b) => b - a).map((year) => (
            <div key={year}>
              <p className="mb-1 font-mono text-xs font-bold text-slate-400">{year}</p>
              <ol className="grid gap-x-4 gap-y-0.5 text-xs text-slate-400 sm:grid-cols-2">
                {[...standings[year]].sort((a, b) => a.r - b.r).map((s) => (
                  <li key={s.n} className="flex gap-2">
                    <span className={cx(
                      'w-5 shrink-0 text-right tabular-nums',
                      s.r === 1 ? 'font-bold text-amber-400' : 'text-slate-600'
                    )}>
                      {s.r}
                    </span>
                    <span className={cx('truncate', s.r === 1 && 'font-semibold text-slate-200')}>{s.n}</span>
                  </li>
                ))}
              </ol>
            </div>
          ))}
        </div>
      </Drawer>

      <Drawer icon={Swords} title="Head to head" subtitle="All-time record against every other manager">
        <div className="overflow-x-auto">
          <table className="min-w-full text-xs">
            <thead>
              <tr className="border-b border-slate-800">
                <th className="sticky left-0 bg-slate-900 px-3 py-2 text-left font-semibold text-slate-500">vs</th>
                {h2hNames.map((n) => (
                  <th key={n} className="px-2 py-2 text-center font-semibold text-slate-500">
                    {n.split(' ').map((w) => w[0]).join('')}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60">
              {h2hNames.map((row) => (
                <tr key={row}>
                  <td className="sticky left-0 bg-slate-900 px-3 py-1.5 font-semibold text-slate-200">{row}</td>
                  {h2hNames.map((col) => {
                    const rec = row === col ? null : h2h[row]?.[col]
                    const [w, l] = (rec ?? '').split('-').map(Number)
                    return (
                      <td
                        key={col}
                        className={cx(
                          'px-2 py-1.5 text-center tabular-nums',
                          !rec ? 'text-slate-700'
                            : w > l ? 'text-emerald-400'
                            : w < l ? 'text-rose-400' : 'text-slate-400'
                        )}
                      >
                        {rec ?? '—'}
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Drawer>

      <p className="px-1 text-xs text-slate-600">
        Hand-maintained. Updated once a season by the commissioner.
      </p>
    </div>
  )
}
