import { useCallback, useEffect, useMemo, useState } from 'react'
import { Plus, Lightbulb, Trash2, Check, X, ShieldAlert } from 'lucide-react'
import { supabase } from '../supabaseClient'
import { logAudit, AUDIT_ACTIONS } from '../lib/audit'
import {
  CATEGORY_CHIP, PROPOSAL_STATUS_STYLES as STATUS, RULE_CATEGORIES, SEASONS, timeAgo,
} from '../lib/constants'
import { appLink, SHARE_TEXT } from '../lib/share'
import {
  Badge, Button, Card, EmptyState, Field, IconButton, Input, Loading, Modal,
  Select, ShareButton, Textarea, cx,
} from './ui'

// Next season by default — the whole point is changes for NEXT year, not a
// mid-season rewrite of the rules everyone is already playing under.
const DEFAULT_SEASON = SEASONS.find((s) => s > new Date().getFullYear()) ?? SEASONS[0]

const EMPTY = {
  title: '', description: '', category: RULE_CATEGORIES[0], target_season: DEFAULT_SEASON,
}

/**
 * Ideas for next season, kept deliberately apart from the rulebook.
 *
 * ⚠️ ANYONE CAN POST HERE. This is the one place a manager writes something the
 * commissioner did not initiate. The rulebook stays commissioner-only, so a
 * proposal can never be mistaken for a rule that has actually been agreed.
 *
 * There is no voting UI. The league votes in person at the draft; the
 * commissioner records the outcome here afterwards, and adopting a proposal
 * writes it into the rulebook properly.
 */
export default function Proposals({ league, membership, members, toast, onDataChanged, focusId }) {
  const me = membership.profile_id
  const isCommish = membership.role === 'commissioner'

  const [proposals, setProposals] = useState([])
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState(null)
  const [showResolved, setShowResolved] = useState(false)

  const [open, setOpen] = useState(false)
  const [form, setForm] = useState(EMPTY)
  const [submitting, setSubmitting] = useState(false)

  // Memoised: without this it is rebuilt on every keystroke in the modal, and
  // `members` cannot change between fetches.
  const nameById = useMemo(
    () => Object.fromEntries(members.map((m) => [m.profile_id, m.team_name])),
    [members]
  )

  const load = useCallback(async () => {
    const { data, error } = await supabase
      .from('rule_proposals')
      .select('*')
      .eq('league_id', league.id)
      .order('created_at', { ascending: false })
    if (error) toast.error(error.message)
    else setProposals(data ?? [])
    setLoading(false)
  }, [league.id, toast])

  useEffect(() => { load() }, [load])

  async function submit(e) {
    e.preventDefault()
    if (!form.title.trim()) return toast.error('Give your idea a title.')
    setSubmitting(true)
    try {
      const { data, error } = await supabase.from('rule_proposals').insert({
        league_id: league.id,
        proposer_id: me,
        title: form.title.trim(),
        description: form.description.trim() || null,
        category: form.category,
        target_season: Number(form.target_season),
      }).select('id').single()
      if (error) throw error
      await logAudit({
        leagueId: league.id, actorId: me, action: AUDIT_ACTIONS.PROPOSAL_ADDED,
        entityType: 'proposal', entityId: data.id,
        details: { title: form.title.trim(), category: form.category,
                   target_season: Number(form.target_season) },
      })
      toast.success('Put forward. The league can see it now.')
      setOpen(false)
      setForm(EMPTY)
      await load()
      onDataChanged?.()
    } catch (err) {
      toast.error(err.message)
    } finally {
      setSubmitting(false)
    }
  }

  async function adopt(p) {
    if (!window.confirm(
      `Adopt "${p.title}"?\n\nIt gets written into the rulebook as an adopted rule ` +
      `effective ${p.target_season}. Do this after the league has actually voted.`
    )) return
    setBusyId(p.id)
    try {
      const { error } = await supabase.rpc('adopt_proposal', { p_proposal: p.id })
      if (error) throw error
      // The RPC logs rule.added for the new rule; this records the proposal
      // side, so the trail shows the idea reaching the book rather than a rule
      // appearing from nowhere.
      await logAudit({
        leagueId: league.id, actorId: me, action: AUDIT_ACTIONS.PROPOSAL_ADOPTED,
        entityType: 'proposal', entityId: p.id,
        details: { title: p.title, raised_by: nameById[p.proposer_id] ?? null },
      })
      toast.success('Adopted and added to the rulebook.')
      await load()
      onDataChanged?.()
    } catch (err) {
      toast.error(err.message)
    } finally {
      setBusyId(null)
    }
  }

  async function decline(p) {
    setBusyId(p.id)
    try {
      const { error } = await supabase
        .from('rule_proposals')
        .update({ status: 'declined', resolved_by: me, resolved_at: new Date().toISOString() })
        .eq('id', p.id)
      if (error) throw error
      await logAudit({
        leagueId: league.id, actorId: me, action: AUDIT_ACTIONS.PROPOSAL_DECLINED,
        entityType: 'proposal', entityId: p.id,
        details: { title: p.title, raised_by: nameById[p.proposer_id] ?? null },
      })
      toast.success('Marked as not adopted.')
      await load()
    } catch (err) {
      toast.error(err.message)
    } finally {
      setBusyId(null)
    }
  }

  async function remove(p) {
    if (!window.confirm(`Delete "${p.title}"? This removes it entirely.`)) return
    setBusyId(p.id)
    try {
      const { error } = await supabase.from('rule_proposals').delete().eq('id', p.id)
      if (error) throw error
      await logAudit({
        leagueId: league.id, actorId: me, action: AUDIT_ACTIONS.PROPOSAL_DELETED,
        entityType: 'proposal', entityId: p.id,
        details: { title: p.title },
      })
      toast.success('Deleted.')
      await load()
    } catch (err) {
      toast.error(err.message)
    } finally {
      setBusyId(null)
    }
  }

  const openOnes = proposals.filter((p) => p.status === 'open')
  const resolved = proposals.filter((p) => p.status !== 'open')
  const shown = showResolved ? proposals : openOnes

  /* A shared link to a settled proposal would otherwise land on a list that
     filters it out — reveal it rather than showing an empty board. */
  useEffect(() => {
    if (!focusId || !proposals.length) return
    const target = proposals.find((p) => p.id === focusId)
    if (!target) return
    if (target.status !== 'open') setShowResolved(true)
    const handle = requestAnimationFrame(() => {
      document.getElementById(`proposal-${focusId}`)
        ?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    })
    return () => cancelAnimationFrame(handle)
  }, [focusId, proposals])

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-bold text-slate-100">Ideas for next season</h3>
          <p className="text-xs text-slate-500">
            Anyone can put one forward. Nothing here is a rule until the league votes
            and the commissioner adopts it.
          </p>
        </div>
        <Button variant="primary" onClick={() => setOpen(true)}>
          <Plus className="h-4 w-4" /> Propose a change
        </Button>
      </div>

      {resolved.length > 0 && (
        <Button
          variant={showResolved ? 'neutral' : 'ghost'}
          className="text-xs"
          onClick={() => setShowResolved((v) => !v)}
        >
          {showResolved && <Check className="h-3 w-3" />}
          Show settled ({resolved.length})
        </Button>
      )}

      {loading ? (
        <Loading label="Loading proposals…" />
      ) : shown.length === 0 ? (
        <Card>
          {/* Distinguish "none exist" from "all of them are filtered out" —
              otherwise this claims nothing was proposed while a "Show settled
              (3)" button sits directly above it saying otherwise. */}
          <EmptyState
            icon={Lightbulb}
            title={proposals.length === 0 ? 'Nothing proposed yet' : 'Nothing open right now'}
          >
            {proposals.length === 0
              ? 'Got a gripe about scoring, keepers or the punishment? Put it forward and the league can chew on it before the draft.'
              : `Every proposal has been settled. Show settled to see all ${resolved.length}.`}
          </EmptyState>
        </Card>
      ) : (
        <div className="space-y-2">
          {shown.map((p) => {
            const style = STATUS[p.status] ?? STATUS.open
            const mine = p.proposer_id === me
            const busy = busyId === p.id
            return (
              <Card
                key={p.id}
                id={`proposal-${p.id}`}
                className={cx(
                  'scroll-mt-32 px-4 py-3',
                  p.status === 'declined' && 'opacity-60',
                  p.id === focusId && 'ring-2 ring-emerald-500/60'
                )}
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="mb-1 flex flex-wrap items-center gap-1.5">
                      <Badge className={CATEGORY_CHIP[p.category]}>{p.category}</Badge>
                      <Badge className="bg-slate-500/15 text-slate-300 ring-slate-500/30">
                        For {p.target_season}
                      </Badge>
                      {p.status !== 'open' && <Badge className={style.chip}>{style.label}</Badge>}
                    </div>
                    <h4 className="font-bold text-slate-100">{p.title}</h4>
                    {p.description && (
                      <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-slate-300">
                        {p.description}
                      </p>
                    )}
                    <p className="mt-2 text-xs text-slate-600">
                      {nameById[p.proposer_id] ?? 'A manager'}
                      {mine && ' (you)'} · {timeAgo(p.created_at)}
                    </p>
                  </div>

                  <div className="flex shrink-0 items-center gap-1">
                    {/* An idea nobody reads is not a proposal, it is a diary
                        entry. Open ones only — a settled one is a record. */}
                    {p.status === 'open' && (
                      <ShareButton
                        compact
                        toast={toast}
                        label="Share this proposal"
                        url={appLink({ tab: 'rules', focus: p.id })}
                        text={SHARE_TEXT.proposal({
                          title: p.title,
                          author: nameById[p.proposer_id] ?? 'Someone',
                        })}
                      />
                    )}
                    {(mine || isCommish) && p.status === 'open' && (
                      <IconButton label={`Delete ${p.title}`} disabled={busy} onClick={() => remove(p)}>
                        <Trash2 className="h-4 w-4" />
                      </IconButton>
                    )}
                  </div>
                </div>

                {isCommish && p.status === 'open' && (
                  <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-slate-800 pt-2.5">
                    <span className="flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-amber-400">
                      <ShieldAlert className="h-3 w-3" aria-hidden /> After the vote
                    </span>
                    <Button variant="primary" busy={busy} onClick={() => adopt(p)}>
                      <Check className="h-3.5 w-3.5" /> Adopt into rulebook
                    </Button>
                    <Button variant="neutral" busy={busy} onClick={() => decline(p)}>
                      <X className="h-3.5 w-3.5" /> Not adopted
                    </Button>
                  </div>
                )}
              </Card>
            )
          })}
        </div>
      )}

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Propose a rule change"
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            <Button variant="primary" busy={submitting} onClick={submit}>Put it forward</Button>
          </>
        }
      >
        <form onSubmit={submit} className="space-y-3">
          <Field label="Title">
            <Input
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
              placeholder="Two keepers instead of one"
              required
            />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Category">
              <Select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
                {RULE_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
              </Select>
            </Field>
            <Field label="Effective season">
              <Select
                value={form.target_season}
                onChange={(e) => setForm({ ...form, target_season: e.target.value })}
              >
                {SEASONS.map((s) => <option key={s} value={s}>{s}</option>)}
              </Select>
            </Field>
          </div>
          <Field label="The case for it" hint="What changes and why. This is what people will argue about.">
            <Textarea
              rows={5}
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              placeholder="One keeper makes the draft stale by round 3…"
            />
          </Field>
          <p className="rounded-lg bg-slate-950/60 px-3 py-2 text-xs text-slate-500 ring-1 ring-slate-800">
            Everyone in the league sees this. It does not become a rule until the
            league votes and the commissioner adopts it.
          </p>
        </form>
      </Modal>
    </div>
  )
}
