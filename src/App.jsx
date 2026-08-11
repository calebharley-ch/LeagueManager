import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Trophy, ArrowLeftRight, ScrollText, History, UserCircle, LogOut, Users,
  ShieldCheck, CheckCircle2, AlertCircle, X, Settings, ChevronDown,
} from 'lucide-react'
import { supabase } from './supabaseClient'
import { buildTeams } from './lib/teams'
import Auth from './components/Auth'
import LeagueGate from './components/LeagueGate'
import LeagueSettings from './components/LeagueSettings'
import TradeTracker from './components/TradeTracker'
import Rulebook from './components/Rulebook'
import AuditLog from './components/AuditLog'
import Rosters from './components/Rosters'
import Profile from './components/Profile'
import { Badge, Button, Card, CountBadge, Loading, cx } from './components/ui'

const ACTIVE_LEAGUE_KEY = 'lm_active_league'

const TABS = [
  { key: 'trades',   label: 'Trades',    icon: ArrowLeftRight },
  { key: 'rules',    label: 'Rules',     icon: ScrollText },
  { key: 'rosters',  label: 'Rosters',   icon: Users },
  { key: 'audit',    label: 'Audit Log', icon: History },
  { key: 'settings', label: 'Settings',  icon: Settings },
  { key: 'profile',  label: 'Profile',   icon: UserCircle },
]

/* ── Toasts ───────────────────────────────────────────────────────────────── */

function useToasts() {
  const [items, setItems] = useState([])
  const timers = useRef(new Map())

  const dismiss = useCallback((id) => {
    setItems((cur) => cur.filter((t) => t.id !== id))
    const handle = timers.current.get(id)
    if (handle) { clearTimeout(handle); timers.current.delete(id) }
  }, [])

  const push = useCallback((tone, message) => {
    if (!message) return
    const id = Math.random().toString(36).slice(2)
    setItems((cur) => [...cur, { id, tone, message: String(message) }])
    timers.current.set(id, setTimeout(() => dismiss(id), tone === 'error' ? 8000 : 4000))
  }, [dismiss])

  useEffect(() => () => { timers.current.forEach(clearTimeout); timers.current.clear() }, [])

  // Memoised so it can sit in child dependency arrays without re-firing every
  // render — the data-loading useCallbacks all take `toast`.
  const toast = useMemo(() => ({
    success: (m) => push('success', m),
    error: (m) => push('error', m),
  }), [push])

  return { items, toast, dismiss }
}

function ToastStack({ items, dismiss }) {
  if (items.length === 0) return null
  return (
    <div
      className="pointer-events-none fixed inset-x-0 bottom-0 z-[60] flex flex-col items-center gap-2 p-4 sm:items-end"
      role="status"
      aria-live="polite"
    >
      {items.map((t) => {
        const isError = t.tone === 'error'
        const Icon = isError ? AlertCircle : CheckCircle2
        return (
          <div
            key={t.id}
            className={cx(
              'pointer-events-auto flex w-full max-w-md items-start gap-2.5 rounded-xl px-3.5 py-2.5',
              'shadow-lg ring-1 backdrop-blur',
              isError ? 'bg-rose-950/90 text-rose-100 ring-rose-500/40'
                      : 'bg-emerald-950/90 text-emerald-100 ring-emerald-500/40'
            )}
          >
            <Icon className={cx('mt-0.5 h-4 w-4 shrink-0', isError ? 'text-rose-400' : 'text-emerald-400')} aria-hidden />
            <p className="flex-1 text-sm">{t.message}</p>
            <button onClick={() => dismiss(t.id)} aria-label="Dismiss"
                    className="shrink-0 rounded p-0.5 opacity-60 transition-opacity hover:opacity-100">
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )
      })}
    </div>
  )
}

/* ── App ──────────────────────────────────────────────────────────────────── */

export default function App() {
  const { items, toast, dismiss } = useToasts()

  const [session, setSession] = useState(null)
  const [authReady, setAuthReady] = useState(false)

  const [memberships, setMemberships] = useState([])
  const [membershipsReady, setMembershipsReady] = useState(false)
  const [loadError, setLoadError] = useState(null)

  const [leagueId, setLeagueId] = useState(() => {
    try { return localStorage.getItem(ACTIVE_LEAGUE_KEY) || null } catch { return null }
  })
  const [members, setMembers] = useState([])
  const [espnTeams, setEspnTeams] = useState([])
  const [tab, setTab] = useState('trades')
  const [switcherOpen, setSwitcherOpen] = useState(false)

  const [refreshKey, setRefreshKey] = useState(0)
  const bumpRefresh = useCallback(() => setRefreshKey((n) => n + 1), [])
  const [badges, setBadges] = useState({ trades: 0, rules: 0 })

  /* Session ---------------------------------------------------------------- */
  useEffect(() => {
    let alive = true
    supabase.auth.getSession().then(({ data }) => {
      if (!alive) return
      setSession(data.session ?? null)
      setAuthReady(true)
    })
    const { data: sub } = supabase.auth.onAuthStateChange((_e, next) => {
      setSession(next ?? null)
      setAuthReady(true)
      if (!next) {
        setMemberships([]); setMembers([]); setLeagueId(null); setTab('trades')
        try { localStorage.removeItem(ACTIVE_LEAGUE_KEY) } catch { /* ignore */ }
      }
    })
    return () => { alive = false; sub.subscription.unsubscribe() }
  }, [])

  /* Memberships ------------------------------------------------------------ */
  const loadMemberships = useCallback(async () => {
    if (!session?.user) return
    const { data, error } = await supabase
      .from('league_members')
      .select('*, leagues(*)')
      .eq('profile_id', session.user.id)
      .order('joined_at', { ascending: true })
    if (error) { setLoadError(error.message); setMembershipsReady(true); return }
    setLoadError(null)
    setMemberships(data ?? [])
    setMembershipsReady(true)
  }, [session])

  useEffect(() => { loadMemberships() }, [loadMemberships])

  const membership = useMemo(
    () => memberships.find((m) => m.league_id === leagueId) ?? null,
    [memberships, leagueId]
  )
  const league = membership?.leagues ?? null

  // A stored league id survives sign-out/in and league removal, so drop it the
  // moment it stops matching a real membership — otherwise the app renders a
  // shell with no data and no explanation.
  useEffect(() => {
    if (!membershipsReady || !leagueId) return
    if (!memberships.some((m) => m.league_id === leagueId)) {
      setLeagueId(null)
      try { localStorage.removeItem(ACTIVE_LEAGUE_KEY) } catch { /* ignore */ }
    }
  }, [membershipsReady, memberships, leagueId])

  const pickLeague = useCallback((id) => {
    setLeagueId(id)
    setTab('trades')
    setSwitcherOpen(false)
    try { localStorage.setItem(ACTIVE_LEAGUE_KEY, id) } catch { /* ignore */ }
  }, [])

  /* League members --------------------------------------------------------- */
  const loadMembers = useCallback(async () => {
    if (!leagueId) return
    const { data, error } = await supabase
      .from('league_members')
      .select('*')
      .eq('league_id', leagueId)
      .order('team_name', { ascending: true })
    if (error) toast.error(error.message)
    else setMembers(data ?? [])
  }, [leagueId, toast])

  useEffect(() => { loadMembers() }, [loadMembers, refreshKey])

  /* ESPN teams -------------------------------------------------------------
     Loaded here rather than inside Rosters because a "team" is league-wide
     vocabulary now: Trades needs it for the counterparty list, Profile needs it
     for claiming, Rosters needs it for FAAB. One fetch, one shared shape. */
  const loadEspnTeams = useCallback(async () => {
    if (!leagueId) return
    const { data, error } = await supabase
      .from('espn_teams')
      .select('*')
      .eq('league_id', leagueId)
    if (error) { toast.error(error.message); return }
    // Only the newest synced season. Mixing seasons would list every team twice.
    const all = data ?? []
    const latest = all.length ? Math.max(...all.map((t) => t.season)) : null
    setEspnTeams(all.filter((t) => t.season === latest))
  }, [leagueId, toast])

  useEffect(() => { loadEspnTeams() }, [loadEspnTeams, refreshKey])

  const teams = useMemo(
    () => buildTeams({ espnTeams, members }),
    [espnTeams, members]
  )

  /* Badges ----------------------------------------------------------------- */
  const loadBadges = useCallback(async () => {
    if (!leagueId || !session?.user) return
    const uid = session.user.id
    const [tradesRes, rulesRes, votesRes] = await Promise.all([
      // head:true + count returns the number without shipping any rows.
      supabase.from('trades').select('id', { count: 'exact', head: true })
        .eq('league_id', leagueId).eq('receiver_id', uid).eq('status', 'pending'),
      supabase.from('league_rules').select('id').eq('league_id', leagueId).eq('status', 'proposed'),
      supabase.from('rule_votes').select('rule_id').eq('voter_id', uid),
    ])
    const voted = new Set((votesRes.data ?? []).map((v) => v.rule_id))
    setBadges({
      trades: tradesRes.count ?? 0,
      rules: (rulesRes.data ?? []).filter((r) => !voted.has(r.id)).length,
    })
  }, [leagueId, session])

  useEffect(() => { loadBadges() }, [loadBadges, refreshKey])

  useEffect(() => {
    const onFocus = () => bumpRefresh()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [bumpRefresh])

  const refreshLeague = useCallback(async () => {
    await Promise.all([loadMemberships(), loadMembers()])
    bumpRefresh()
  }, [loadMemberships, loadMembers, bumpRefresh])

  /* Render ----------------------------------------------------------------- */
  if (!authReady) {
    return <div className="flex min-h-full items-center justify-center"><Loading label="Starting up…" /></div>
  }

  if (!session) {
    return (
      <>
        <Auth onError={toast.error} />
        <ToastStack items={items} dismiss={dismiss} />
      </>
    )
  }

  if (loadError) {
    return (
      <div className="flex min-h-full items-center justify-center p-6">
        <Card className="max-w-md p-6 text-sm">
          <h2 className="mb-2 text-lg font-bold text-rose-300">Could not load your leagues</h2>
          <p className="mb-3 text-slate-400">{loadError}</p>
          <p className="mb-4 text-xs text-slate-500">
            Usually this means <code className="text-slate-400">schema.sql</code> has not been run,
            or was run before the multi-league rewrite.
          </p>
          <Button variant="neutral" onClick={() => supabase.auth.signOut()}>
            <LogOut className="h-4 w-4" /> Sign out
          </Button>
        </Card>
        <ToastStack items={items} dismiss={dismiss} />
      </div>
    )
  }

  if (!membershipsReady) {
    return <div className="flex min-h-full items-center justify-center"><Loading label="Loading leagues…" /></div>
  }

  if (!membership) {
    return (
      <>
        <LeagueGate
          memberships={memberships}
          onPick={pickLeague}
          onChanged={loadMemberships}
          toast={toast}
          email={session.user.email}
        />
        <ToastStack items={items} dismiss={dismiss} />
      </>
    )
  }

  const isCommish = membership.role === 'commissioner'
  const badgeFor = (k) => (k === 'trades' ? badges.trades : k === 'rules' ? badges.rules : 0)

  return (
    <div className="min-h-full">
      <header className="sticky top-0 z-40 border-b border-slate-800 bg-slate-950/85 backdrop-blur">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-3 px-4 py-3">
          <div className="relative flex min-w-0 items-center gap-2.5">
            <div className="rounded-lg bg-emerald-500/10 p-1.5 ring-1 ring-emerald-500/30">
              <Trophy className="h-5 w-5 text-emerald-400" aria-hidden />
            </div>
            <button
              onClick={() => setSwitcherOpen((v) => !v)}
              className="min-w-0 text-left"
              aria-haspopup="true"
              aria-expanded={switcherOpen}
            >
              <p className="flex items-center gap-1 truncate text-sm font-black leading-tight text-slate-100">
                {league.name}
                <ChevronDown className="h-3.5 w-3.5 shrink-0 text-slate-500" aria-hidden />
              </p>
              <p className="truncate text-xs text-slate-500">{membership.team_name}</p>
            </button>

            {switcherOpen && (
              <>
                {/* Full-screen catcher so any outside click closes the menu. */}
                <div className="fixed inset-0 z-10" onClick={() => setSwitcherOpen(false)} />
                <Card className="absolute left-0 top-full z-20 mt-2 w-64 overflow-hidden p-0">
                  {memberships.map((m) => (
                    <button
                      key={m.league_id}
                      onClick={() => pickLeague(m.league_id)}
                      className={cx(
                        'flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm transition-colors',
                        m.league_id === leagueId ? 'bg-slate-800 text-slate-100' : 'text-slate-300 hover:bg-slate-800/60'
                      )}
                    >
                      <span className="min-w-0">
                        <span className="block truncate font-semibold">{m.leagues.name}</span>
                        <span className="block truncate text-xs text-slate-500">{m.team_name}</span>
                      </span>
                      {m.role === 'commissioner' && (
                        <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-amber-400" aria-hidden />
                      )}
                    </button>
                  ))}
                  <button
                    onClick={() => { setLeagueId(null); setSwitcherOpen(false) }}
                    className="w-full border-t border-slate-800 px-3 py-2 text-left text-sm text-emerald-400 hover:bg-slate-800/60"
                  >
                    Create or join a league…
                  </button>
                </Card>
              </>
            )}
          </div>

          <div className="flex items-center gap-2">
            {isCommish ? (
              <Badge className="bg-amber-500/15 text-amber-300 ring-amber-500/30">
                <ShieldCheck className="h-3 w-3" aria-hidden />
                <span className="hidden sm:inline">Commissioner</span>
              </Badge>
            ) : (
              <Badge className="bg-slate-500/15 text-slate-300 ring-slate-500/30">Manager</Badge>
            )}
            <Button variant="ghost" onClick={() => supabase.auth.signOut()}>
              <LogOut className="h-4 w-4" />
              <span className="hidden sm:inline">Sign out</span>
            </Button>
          </div>
        </div>

        <nav className="mx-auto max-w-5xl px-2">
          <div className="flex gap-1 overflow-x-auto scrollbar-thin">
            {TABS.map(({ key, label, icon: Icon }) => (
              <button
                key={key}
                onClick={() => { setTab(key); bumpRefresh() }}
                aria-current={tab === key ? 'page' : undefined}
                className={cx(
                  'flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2.5 text-sm font-semibold transition-colors',
                  tab === key ? 'border-emerald-500 text-slate-100'
                              : 'border-transparent text-slate-400 hover:text-slate-200'
                )}
              >
                <Icon className="h-4 w-4" aria-hidden />
                {label}
                <CountBadge count={badgeFor(key)} />
              </button>
            ))}
          </div>
        </nav>
      </header>

      <main className="mx-auto max-w-5xl px-4 py-5">
        {tab === 'trades' && (
          <TradeTracker league={league} membership={membership} members={members}
                        teams={teams} toast={toast} onDataChanged={bumpRefresh} />
        )}
        {tab === 'rules' && (
          <Rulebook league={league} membership={membership} members={members}
                    toast={toast} onDataChanged={bumpRefresh} />
        )}
        {tab === 'rosters' && (
          <Rosters league={league} teams={teams} toast={toast} refreshKey={refreshKey} />
        )}
        {tab === 'audit' && (
          <AuditLog league={league} members={members} toast={toast} refreshKey={refreshKey} />
        )}
        {tab === 'settings' && (
          <LeagueSettings league={league} membership={membership} members={members}
                          toast={toast} onChanged={refreshLeague} />
        )}
        {tab === 'profile' && (
          <Profile league={league} membership={membership} members={members}
                   teams={teams} session={session} toast={toast}
                   onChanged={refreshLeague} />
        )}
      </main>

      <ToastStack items={items} dismiss={dismiss} />
    </div>
  )
}
