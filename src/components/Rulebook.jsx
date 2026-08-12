import { useCallback, useEffect, useMemo, useState } from 'react'
import { Plus, ScrollText, Trash2, Pencil, BookOpen, Check } from 'lucide-react'
import { supabase } from '../supabaseClient'
import { logAudit, AUDIT_ACTIONS } from '../lib/audit'
import { RULE_CATEGORIES, RULE_STATUS_STYLES, SEASONS, timeAgo } from '../lib/constants'
import {
  Badge, Button, Card, EmptyState, Field, IconButton, Input, Loading, Modal,
  Select, Textarea, cx,
} from './ui'

const CATEGORY_CHIP = {
  Scoring:    'bg-indigo-500/15 text-indigo-300 ring-indigo-500/30',
  Roster:     'bg-purple-500/15 text-purple-300 ring-purple-500/30',
  Draft:      'bg-sky-500/15 text-sky-300 ring-sky-500/30',
  Financial:  'bg-emerald-500/15 text-emerald-300 ring-emerald-500/30',
  Governance: 'bg-amber-500/15 text-amber-300 ring-amber-500/30',
}

// Order rules are shown in, regardless of when they were written. A rulebook
// reads best grouped by subject.
const CATEGORY_ORDER = RULE_CATEGORIES

const EMPTY_FORM = {
  id: null,
  title: '',
  description: '',
  category: RULE_CATEGORIES[0],
  effective_season: SEASONS[0],
  status: 'passed',
}

/* ── One written rule ─────────────────────────────────────────────────────── */
function RuleCard({ rule, authorName, canManage, onEdit, onDelete, busy }) {
  const style = RULE_STATUS_STYLES[rule.status] ?? RULE_STATUS_STYLES.passed
  return (
    <Card className={cx('px-4 py-3', rule.status === 'rejected' && 'opacity-60')}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex flex-wrap items-center gap-1.5">
            <Badge className={CATEGORY_CHIP[rule.category]}>{rule.category}</Badge>
            <Badge className="bg-slate-500/15 text-slate-300 ring-slate-500/30">
              Effective {rule.effective_season}
            </Badge>
            {rule.status !== 'passed' && <Badge className={style.chip}>{style.label}</Badge>}
          </div>
          <h3 className={cx(
            'font-bold text-slate-100',
            rule.status === 'rejected' && 'line-through decoration-slate-600'
          )}>
            {rule.title}
          </h3>
          {rule.description && (
            <p className="mt-1.5 whitespace-pre-wrap text-sm leading-relaxed text-slate-300">
              {rule.description}
            </p>
          )}
          <p className="mt-2 text-xs text-slate-600">
            Written by {authorName} · {timeAgo(rule.created_at)}
          </p>
        </div>

        {canManage && (
          <div className="flex shrink-0 items-center gap-1">
            <IconButton label="Edit rule" onClick={() => onEdit(rule)} disabled={busy}>
              <Pencil className="h-4 w-4" />
            </IconButton>
            <IconButton label="Delete rule" onClick={() => onDelete(rule)} disabled={busy}>
              <Trash2 className="h-4 w-4" />
            </IconButton>
          </div>
        )}
      </div>
    </Card>
  )
}

/* ══════════════════════════════════════════════════════════════════════════
   The rulebook is a RECORD, not a ballot. It stores what the league has
   already agreed — no voting, no ratification flow. Rules are written down,
   edited when they change, and struck through when repealed.
   ══════════════════════════════════════════════════════════════════════════ */
export default function Rulebook({ league, membership, members, toast, onDataChanged }) {
  const me = membership.profile_id
  const isCommish = membership.role === 'commissioner'

  const [rules, setRules] = useState([])
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState(null)
  const [filterCat, setFilterCat] = useState('all')
  const [showRepealed, setShowRepealed] = useState(false)

  const [modalOpen, setModalOpen] = useState(false)
  const [form, setForm] = useState(EMPTY_FORM)
  const [submitting, setSubmitting] = useState(false)

  const nameById = useMemo(
    () => Object.fromEntries(members.map((m) => [m.profile_id, m.team_name])),
    [members]
  )

  const load = useCallback(async () => {
    const { data, error } = await supabase
      .from('league_rules')
      .select('*')
      .eq('league_id', league.id)
      .order('created_at', { ascending: true })
    if (error) toast.error(error.message)
    else setRules(data ?? [])
    setLoading(false)
  }, [toast, league.id])

  useEffect(() => { load() }, [load])

  function openNew() {
    setForm(EMPTY_FORM)
    setModalOpen(true)
  }

  function openEdit(rule) {
    setForm({
      id: rule.id,
      title: rule.title,
      description: rule.description ?? '',
      category: rule.category,
      effective_season: rule.effective_season,
      status: rule.status,
    })
    setModalOpen(true)
  }

  async function submitRule(e) {
    e.preventDefault()
    if (!form.title.trim()) return toast.error('Give the rule a title.')
    setSubmitting(true)
    try {
      const payload = {
        title: form.title.trim(),
        description: form.description.trim() || null,
        category: form.category,
        effective_season: Number(form.effective_season),
        status: form.status,
      }

      if (form.id) {
        // ⚠️ Only the commissioner can UPDATE league_rules — that is the RLS
        // policy, and the edit buttons are hidden accordingly. If this ever
        // returns zero rows for a manager, that is the policy working.
        const { error } = await supabase
          .from('league_rules').update(payload).eq('id', form.id)
        if (error) throw error
        await logAudit({
          leagueId: league.id, actorId: me, action: AUDIT_ACTIONS.RULE_UPDATED,
          entityType: 'rule', entityId: form.id,
          details: { title: payload.title, category: payload.category },
        })
        toast.success('Rule updated.')
      } else {
        const { data, error } = await supabase
          .from('league_rules')
          .insert({ ...payload, league_id: league.id, proposer_id: me })
          .select().single()
        if (error) throw error
        await logAudit({
          leagueId: league.id, actorId: me, action: AUDIT_ACTIONS.RULE_ADDED,
          entityType: 'rule', entityId: data.id,
          details: { title: data.title, category: data.category },
        })
        toast.success('Rule added to the book.')
      }

      setModalOpen(false)
      setForm(EMPTY_FORM)
      await load()
      onDataChanged?.()
    } catch (err) {
      toast.error(err.message)
    } finally {
      setSubmitting(false)
    }
  }

  async function handleDelete(rule) {
    if (!window.confirm(
      `Delete "${rule.title}" permanently?\n\nIf the rule was retired rather than ` +
      `written in error, edit it and set the status to Repealed instead — that keeps ` +
      `the history.`
    )) return
    setBusyId(rule.id)
    try {
      const { error } = await supabase.from('league_rules').delete().eq('id', rule.id)
      if (error) throw error
      await logAudit({
        leagueId: league.id, actorId: me, action: AUDIT_ACTIONS.RULE_DELETED,
        entityType: 'rule', entityId: rule.id,
        details: { title: rule.title, category: rule.category },
      })
      toast.success('Rule deleted.')
      await load()
      onDataChanged?.()
    } catch (err) {
      toast.error(err.message)
    } finally {
      setBusyId(null)
    }
  }

  const visible = rules.filter((r) =>
    (filterCat === 'all' || r.category === filterCat) &&
    (showRepealed || r.status !== 'rejected')
  )

  const grouped = CATEGORY_ORDER
    .map((cat) => [cat, visible.filter((r) => r.category === cat)])
    .filter(([, list]) => list.length > 0)

  const repealedCount = rules.filter((r) => r.status === 'rejected').length

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-black tracking-tight text-slate-100">Rulebook</h2>
          <p className="text-sm text-slate-500">
            What the league has agreed, written down. {rules.length} rule
            {rules.length === 1 ? '' : 's'} on the books.
          </p>
        </div>
        {/* Commissioner only, matching the RLS. Showing this to a manager would
            just produce a policy violation after they had typed the whole rule. */}
        {isCommish && (
          <Button variant="primary" onClick={openNew}>
            <Plus className="h-4 w-4" /> Add rule
          </Button>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Select
          className="w-auto"
          value={filterCat}
          onChange={(e) => setFilterCat(e.target.value)}
          aria-label="Filter by category"
        >
          <option value="all">All categories</option>
          {RULE_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
        </Select>
        {repealedCount > 0 && (
          <Button
            variant={showRepealed ? 'neutral' : 'ghost'}
            className="text-xs"
            onClick={() => setShowRepealed((v) => !v)}
          >
            {showRepealed && <Check className="h-3 w-3" />}
            Show repealed ({repealedCount})
          </Button>
        )}
      </div>

      {loading ? (
        <Loading label="Loading the rulebook…" />
      ) : grouped.length === 0 ? (
        <Card>
          <EmptyState icon={BookOpen} title={rules.length === 0 ? 'The book is empty' : 'Nothing matches'}>
            {rules.length > 0
              ? 'Try widening the filter.'
              : isCommish
                ? 'Add your keeper rules, draft format and punishments so nobody has to remember them in August.'
                : 'Your commissioner has not written any rules down yet.'}
          </EmptyState>
        </Card>
      ) : (
        <div className="space-y-5">
          {grouped.map(([cat, list]) => (
            <section key={cat} className="space-y-2">
              <h3 className="flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-slate-500">
                <ScrollText className="h-3.5 w-3.5" aria-hidden />
                {cat}
                <span className="font-normal text-slate-600">({list.length})</span>
              </h3>
              {list.map((r) => (
                <RuleCard
                  key={r.id}
                  rule={r}
                  authorName={nameById[r.proposer_id] ?? 'the commissioner'}
                  canManage={isCommish}
                  onEdit={openEdit}
                  onDelete={handleDelete}
                  busy={busyId === r.id}
                />
              ))}
            </section>
          ))}
        </div>
      )}

      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title={form.id ? 'Edit rule' : 'Add a rule'}
        footer={
          <>
            <Button variant="ghost" onClick={() => setModalOpen(false)}>Cancel</Button>
            <Button variant="primary" busy={submitting} onClick={submitRule}>
              {form.id ? 'Save changes' : 'Add to rulebook'}
            </Button>
          </>
        }
      >
        <form onSubmit={submitRule} className="space-y-3">
          <Field label="Title">
            <Input
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
              placeholder="Keeper rules"
              required
            />
          </Field>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Category">
              <Select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
                {RULE_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
              </Select>
            </Field>
            <Field label="Effective season">
              <Select
                value={form.effective_season}
                onChange={(e) => setForm({ ...form, effective_season: e.target.value })}
              >
                {SEASONS.map((s) => <option key={s} value={s}>{s}</option>)}
              </Select>
            </Field>
            <Field label="Status">
              <Select
                value={form.status}
                onChange={(e) => setForm({ ...form, status: e.target.value })}
                disabled={!isCommish && !!form.id}
              >
                <option value="passed">Adopted</option>
                <option value="proposed">Draft</option>
                <option value="rejected">Repealed</option>
              </Select>
            </Field>
          </div>
          <Field
            label="The rule"
            hint="Write it the way you would settle an argument with it. One line per clause."
          >
            <Textarea
              rows={7}
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              placeholder={'• A player cannot be kept two years in a row.\n• A first-round pick cannot be kept.'}
            />
          </Field>
        </form>
      </Modal>
    </div>
  )
}
