import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ArrowLeftRight, Check, X, Gavel, Ban, Trash2, ScrollText, ThumbsUp,
  History, RefreshCw, ShieldAlert, Lightbulb,
} from 'lucide-react'
import { supabase } from '../supabaseClient'
import { AUDIT_ACTIONS, AUDIT_FROM_CLIENT } from '../lib/audit'
import { timeAgo } from '../lib/constants'
import { Badge, Card, EmptyState, IconButton, Loading, Select, cx } from './ui'

const PAGE_SIZE = 50

// icon + tone + a sentence template per action. Keeping the copy here rather
// than in the row keeps the feed readable as one voice.
const ACTION_META = {
  [AUDIT_ACTIONS.TRADE_PROPOSED]:  { icon: ArrowLeftRight, tone: 'text-sky-400',     verb: 'proposed a trade' },
  [AUDIT_ACTIONS.TRADE_ACCEPTED]:  { icon: Check,          tone: 'text-emerald-400', verb: 'accepted a trade' },
  [AUDIT_ACTIONS.TRADE_REJECTED]:  { icon: X,              tone: 'text-slate-400',   verb: 'rejected a trade' },
  [AUDIT_ACTIONS.TRADE_COMPLETED]: { icon: Gavel,          tone: 'text-emerald-400', verb: 'force-completed a trade' },
  [AUDIT_ACTIONS.TRADE_VETOED]:    { icon: Ban,            tone: 'text-rose-400',    verb: 'vetoed a trade' },
  [AUDIT_ACTIONS.TRADE_DELETED]:   { icon: Trash2,         tone: 'text-rose-400',    verb: 'deleted a trade' },
  [AUDIT_ACTIONS.RULE_ADDED]:      { icon: ScrollText,     tone: 'text-indigo-400',  verb: 'added a rule' },
  [AUDIT_ACTIONS.RULE_UPDATED]:    { icon: ScrollText,     tone: 'text-indigo-400',  verb: 'edited a rule' },
  [AUDIT_ACTIONS.RULE_DELETED]:    { icon: Trash2,         tone: 'text-rose-400',    verb: 'deleted a rule' },
  [AUDIT_ACTIONS.PROPOSAL_ADDED]:    { icon: Lightbulb, tone: 'text-sky-400',     verb: 'proposed a change for next season' },
  [AUDIT_ACTIONS.PROPOSAL_ADOPTED]:  { icon: Gavel,     tone: 'text-emerald-400', verb: 'adopted a proposal' },
  [AUDIT_ACTIONS.PROPOSAL_DECLINED]: { icon: Ban,       tone: 'text-slate-400',   verb: 'declined a proposal' },
  [AUDIT_ACTIONS.PROPOSAL_DELETED]:  { icon: Trash2,    tone: 'text-slate-400',   verb: 'withdrew a proposal' },
  [AUDIT_ACTIONS.RULE_PROPOSED]:   { icon: ScrollText,     tone: 'text-indigo-400',  verb: 'proposed a rule' },
  [AUDIT_ACTIONS.RULE_VOTED]:      { icon: ThumbsUp,       tone: 'text-slate-400',   verb: 'voted on a rule' },
  [AUDIT_ACTIONS.RULE_RATIFIED]:   { icon: Gavel,          tone: 'text-emerald-400', verb: 'ratified a rule' },
  [AUDIT_ACTIONS.RULE_REJECTED]:   { icon: Ban,            tone: 'text-rose-400',    verb: 'rejected a rule' },
}

const FILTERS = [
  ['all', 'Everything'],
  ['trade', 'Trades only'],
  ['rule', 'Rules only'],
  ['commish', 'Commissioner actions'],
]

const COMMISH_ACTIONS = new Set([
  AUDIT_ACTIONS.TRADE_COMPLETED,
  AUDIT_ACTIONS.TRADE_VETOED,
  AUDIT_ACTIONS.TRADE_DELETED,
  AUDIT_ACTIONS.RULE_UPDATED,
  AUDIT_ACTIONS.RULE_DELETED,
  AUDIT_ACTIONS.RULE_RATIFIED,
  AUDIT_ACTIONS.RULE_REJECTED,
  // Resolving a proposal is a commissioner act. Raising or withdrawing one is
  // not — anybody can do those, and badging them "Commissioner" was the bug.
  AUDIT_ACTIONS.PROPOSAL_ADOPTED,
  AUDIT_ACTIONS.PROPOSAL_DECLINED,
])

/** Turn the details jsonb into a short human clause. Unknown shapes fall back
 *  to nothing rather than dumping raw JSON at the reader. */
function detailLine(entry) {
  const d = entry.details || {}
  switch (entry.action) {
    case AUDIT_ACTIONS.TRADE_PROPOSED:
      return d.to ? `to ${d.to}` : null
    case AUDIT_ACTIONS.TRADE_ACCEPTED:
    case AUDIT_ACTIONS.TRADE_REJECTED:
    case AUDIT_ACTIONS.TRADE_COMPLETED:
    case AUDIT_ACTIONS.TRADE_VETOED:
    case AUDIT_ACTIONS.TRADE_DELETED:
      return d.proposer && d.receiver ? `${d.proposer} ↔ ${d.receiver}` : null
    case AUDIT_ACTIONS.RULE_VOTED:
      return d.title ? `${d.vote === 'yes' ? '👍' : '👎'} ${d.title}` : null
    case AUDIT_ACTIONS.PROPOSAL_ADDED:
    case AUDIT_ACTIONS.PROPOSAL_ADOPTED:
    case AUDIT_ACTIONS.PROPOSAL_DECLINED:
    case AUDIT_ACTIONS.PROPOSAL_DELETED:
    case AUDIT_ACTIONS.RULE_ADDED:
    case AUDIT_ACTIONS.RULE_UPDATED:
    case AUDIT_ACTIONS.RULE_DELETED:
    case AUDIT_ACTIONS.RULE_PROPOSED:
    case AUDIT_ACTIONS.RULE_RATIFIED:
    case AUDIT_ACTIONS.RULE_REJECTED:
      return d.title ?? null
    default:
      return null
  }
}

export default function AuditLog({ league, members, toast, refreshKey }) {
  const [entries, setEntries] = useState([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState('all')

  const teamNameById = useMemo(
    () => Object.fromEntries(members.map((m) => [m.profile_id, m.team_name])),
    [members]
  )

  const load = useCallback(async () => {
    const { data, error } = await supabase
      .from('audit_log')
      .select('*')
      .eq('league_id', league.id)
      .order('created_at', { ascending: false })
      .limit(PAGE_SIZE)
    if (error) toast.error(error.message)
    else setEntries(data ?? [])
    setLoading(false)
  }, [toast, league.id])

  // refreshKey bumps whenever another tab mutates something, so the log is
  // current the moment you switch to it without polling.
  useEffect(() => { load() }, [load, refreshKey])

  const shown = entries.filter((e) => {
    if (filter === 'all') return true
    if (filter === 'commish') return COMMISH_ACTIONS.has(e.action)
    return e.entity_type === filter
  })

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-black tracking-tight text-slate-100">Audit log</h2>
          <p className="text-sm text-slate-500">
            Every trade and rule action, newest first. Append-only.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Select className="w-auto" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter log">
            {FILTERS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </Select>
          <IconButton label="Refresh" onClick={load}><RefreshCw className="h-4 w-4" /></IconButton>
        </div>
      </div>

      {!AUDIT_FROM_CLIENT && (
        <p className="rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-300 ring-1 ring-amber-500/30">
          Client-side audit writes are disabled (<code>AUDIT_FROM_CLIENT = false</code>).
          This feed shows only what your database triggers write.
        </p>
      )}

      {loading ? (
        <Loading label="Loading activity…" />
      ) : shown.length === 0 ? (
        <Card>
          <EmptyState icon={History} title="Nothing logged yet">
            Propose a trade or a rule change and it will appear here.
          </EmptyState>
        </Card>
      ) : (
        <Card className="divide-y divide-slate-800">
          {shown.map((e) => {
            const meta = ACTION_META[e.action] ?? { icon: History, tone: 'text-slate-400', verb: e.action }
            const Icon = meta.icon
            const detail = detailLine(e)
            return (
              <div key={e.id} className="flex items-start gap-3 px-4 py-2.5">
                <Icon className={cx('mt-0.5 h-4 w-4 shrink-0', meta.tone)} aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-slate-200">
                    <span className="font-semibold">{teamNameById[e.actor_id] ?? 'Someone'}</span>{' '}
                    <span className="text-slate-400">{meta.verb}</span>
                    {detail && <span className="text-slate-500"> — {detail}</span>}
                  </p>
                </div>
                {COMMISH_ACTIONS.has(e.action) && (
                  <Badge className="bg-amber-500/15 text-amber-300 ring-amber-500/30">
                    <ShieldAlert className="h-3 w-3" aria-hidden /> Commish
                  </Badge>
                )}
                <span className="shrink-0 text-xs text-slate-500">{timeAgo(e.created_at)}</span>
              </div>
            )
          })}
        </Card>
      )}

      {entries.length >= PAGE_SIZE && (
        <p className="text-center text-xs text-slate-600">
          Showing the most recent {PAGE_SIZE} entries.
        </p>
      )}
    </div>
  )
}
