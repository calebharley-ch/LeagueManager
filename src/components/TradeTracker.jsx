import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ArrowLeftRight, Plus, Trash2, Check, X, Gavel, ShieldAlert,
  Handshake, MessageSquare, ThumbsUp, ThumbsDown,
} from 'lucide-react'
import { supabase } from '../supabaseClient'
import { usePlayers } from '../lib/usePlayers'
import { findTeam, ownPicksTradedAway } from '../lib/teams'
import PlayerPicker from './PlayerPicker'
import { logAudit, AUDIT_ACTIONS } from '../lib/audit'
import {
  ASSET_STYLES, TRADE_STATUS_STYLES, POSITIONS, PICK_ROUNDS, PICK_YEARS,
  MAX_OWN_PICKS_TRADED, describeAsset, timeAgo,
} from '../lib/constants'
import {
  Badge, Button, Card, EmptyState, Field, IconButton, Input, Loading, Modal,
  Select, Textarea, cx,
} from './ui'

let assetKeySeq = 0
const newAsset = (type) => ({
  key: ++assetKeySeq,
  item_type: type,
  player_name: '',
  player_position: 'RB',
  espn_player_id: null,
  faab_amount: '',
  pick_year: PICK_YEARS[0],
  pick_round: 1,
  // A team key from lib/teams ("espn:7" or "member:<uuid>"), not a profile id —
  // the original owner may be a team nobody has claimed.
  pick_original_team_key: '',
})

/* ══════════════════════════════════════════════════════════════════════════
   Asset row — one editable line in the builder
   ══════════════════════════════════════════════════════════════════════════ */
function AssetEditor({ asset, teams, onChange, onRemove, players, rosterIds, rosterLabel }) {
  const set = (patch) => onChange({ ...asset, ...patch })
  const style = ASSET_STYLES[asset.item_type]

  return (
    <div className="flex items-start gap-2 rounded-lg bg-slate-950/50 p-2 ring-1 ring-slate-800">
      <span className={cx('mt-2 h-2 w-2 shrink-0 rounded-full', style.dot)} aria-hidden />
      <div className="grid flex-1 gap-2 sm:grid-cols-2">
        {asset.item_type === 'player' && (
          <>
            {/* Full width. Sharing the row with the position select left the
                search box ~110px, which is what starved the results dropdown. */}
            <PlayerPicker
              className="sm:col-span-2"
              value={asset.player_name}
              position={asset.player_position}
              // Scoped to the sending team's roster. You cannot trade away a
              // player you do not have, so offering the full league here was
              // just a way to build an invalid trade.
              search={(q, limit) => players.search(q, limit, rosterIds)}
              available={rosterIds ? rosterIds.size > 0 : players.players.length > 0}
              placeholder={rosterIds ? `Search ${rosterLabel}'s roster…` : undefined}
              onChange={set}
            />
            <Select
              className="sm:col-span-2"
              value={asset.player_position}
              onChange={(e) => set({ player_position: e.target.value })}
              aria-label="Position"
            >
              {POSITIONS.map((p) => <option key={p} value={p}>{p}</option>)}
            </Select>
          </>
        )}

        {asset.item_type === 'faab' && (
          <div className="relative sm:col-span-2">
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-slate-500">$</span>
            <Input
              className="pl-7"
              type="number"
              min="1"
              step="1"
              value={asset.faab_amount}
              onChange={(e) => set({ faab_amount: e.target.value })}
              placeholder="FAAB amount"
              aria-label="FAAB amount"
            />
          </div>
        )}

        {asset.item_type === 'pick' && (
          <>
            <Select value={asset.pick_year} onChange={(e) => set({ pick_year: Number(e.target.value) })} aria-label="Pick year">
              {PICK_YEARS.map((y) => <option key={y} value={y}>{y}</option>)}
            </Select>
            <Select value={asset.pick_round} onChange={(e) => set({ pick_round: Number(e.target.value) })} aria-label="Pick round">
              {PICK_ROUNDS.map((r) => <option key={r} value={r}>Round {r}</option>)}
            </Select>
            <Select
              className="sm:col-span-2"
              value={asset.pick_original_team_key}
              onChange={(e) => set({ pick_original_team_key: e.target.value })}
              aria-label="Original owner"
            >
              <option value="">Original owner — unspecified</option>
              {teams.map((t) => <option key={t.key} value={t.key}>{t.team_name}</option>)}
            </Select>
          </>
        )}
      </div>
      <IconButton label="Remove asset" onClick={onRemove}>
        <Trash2 className="h-4 w-4" />
      </IconButton>
    </div>
  )
}

/* ══════════════════════════════════════════════════════════════════════════
   One side of the builder
   ══════════════════════════════════════════════════════════════════════════ */
function SideBuilder({
  heading, subheading, assets, setAssets, teams, players, rosterIds, rosterLabel,
  rosterMissing,
}) {
  const add = (type) => setAssets([...assets, newAsset(type)])
  const update = (key, next) => setAssets(assets.map((a) => (a.key === key ? next : a)))
  const remove = (key) => setAssets(assets.filter((a) => a.key !== key))

  return (
    <div className="rounded-xl bg-slate-900/70 p-3 ring-1 ring-slate-800">
      <div className="mb-2">
        <h4 className="text-sm font-bold text-slate-100">{heading}</h4>
        <p className="text-xs text-slate-500">{subheading}</p>
      </div>

      {rosterMissing && (
        <p className="mb-2 rounded-lg bg-amber-500/10 px-2.5 py-1.5 text-[11px] text-amber-300 ring-1 ring-amber-500/30">
          No synced roster for this team — searching all players instead.
        </p>
      )}

      <div className="space-y-2">
        {assets.length === 0 && (
          <p className="rounded-lg border border-dashed border-slate-800 px-3 py-4 text-center text-xs text-slate-600">
            No assets yet
          </p>
        )}
        {assets.map((a) => (
          <AssetEditor
            key={a.key}
            asset={a}
            teams={teams}
            players={players}
            rosterIds={rosterIds}
            rosterLabel={rosterLabel}
            onChange={(next) => update(a.key, next)}
            onRemove={() => remove(a.key)}
          />
        ))}
      </div>

      <div className="mt-2 flex flex-wrap gap-1.5">
        {Object.entries(ASSET_STYLES).map(([type, style]) => (
          <Button key={type} variant="ghost" className="text-xs" onClick={() => add(type)}>
            <Plus className="h-3 w-3" /> {style.label}
          </Button>
        ))}
      </div>
    </div>
  )
}

/* ══════════════════════════════════════════════════════════════════════════
   Trade card in the feed
   ══════════════════════════════════════════════════════════════════════════ */
/* League vote progress. Two bars rather than one split bar: approvals and
   vetoes race to DIFFERENT thresholds, so a single 50/50 bar would misrepresent
   where a trade actually stands. */
function VoteProgress({ approvals, vetoes, needApprove, needVeto }) {
  const Row = ({ label, count, need, tone, bar }) => (
    <div>
      <div className="mb-1 flex items-center justify-between text-[11px]">
        <span className={cx('font-semibold', tone)}>{label}</span>
        <span className="text-slate-500">{count} of {need}</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-slate-800">
        <div
          className={cx('h-full transition-all', bar)}
          style={{ width: `${Math.min(100, (count / Math.max(need, 1)) * 100)}%` }}
        />
      </div>
    </div>
  )
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      <Row label="Approve" count={approvals} need={needApprove}
           tone="text-emerald-400" bar="bg-emerald-500" />
      <Row label="Veto" count={vetoes} need={needVeto}
           tone="text-rose-400" bar="bg-rose-500" />
    </div>
  )
}

function TradeCard({
  trade, me, isCommish, teams, onAction, busyId, votes = [],
  needApprove, needVeto, onVote,
}) {
  const status = TRADE_STATUS_STYLES[trade.status] ?? TRADE_STATUS_STYLES.pending
  const isReceiver = trade.receiver_id === me
  const isProposer = trade.proposer_id === me
  const pending = trade.status === 'pending'
  const voting = trade.status === 'accepted'
  const busy = busyId === trade.id

  const approvals = votes.filter((v) => v.approve).length
  const vetoes = votes.length - approvals
  const myVote = votes.find((v) => v.voter_id === me)
  // Both sides already agreed by proposing and accepting; letting them vote
  // again would let a trade approve itself. Enforced in the RPC too.
  const isParty = isProposer || isReceiver

  const proposer = findTeam(teams, { profileId: trade.proposer_id })
  const receiver = findTeam(teams, {
    profileId: trade.receiver_id,
    espnTeamId: trade.receiver_espn_team_id,
  })
  const proposerName = proposer?.team_name ?? 'Unknown'
  const receiverName = receiver?.team_name ?? 'Unknown'
  // Nobody can accept on behalf of a team with no account behind it.
  const unclaimedReceiver = !!receiver && !receiver.claimed

  const sideA = (trade.trade_items ?? []).filter((i) => i.side === 'A')
  const sideB = (trade.trade_items ?? []).filter((i) => i.side === 'B')

  const ownerNameFor = (item) =>
    findTeam(teams, {
      profileId: item.pick_original_owner_id,
      espnTeamId: item.pick_original_espn_team_id,
    })?.team_name ?? null

  const AssetList = ({ items, empty }) => (
    <div className="flex flex-wrap gap-1.5">
      {items.length === 0
        ? <span className="text-xs italic text-slate-600">{empty}</span>
        : items.map((i) => (
            <Badge key={i.id} className={ASSET_STYLES[i.item_type].chip}>
              {describeAsset(i, ownerNameFor(i))}
            </Badge>
          ))}
    </div>
  )

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 px-4 py-2.5">
        <div className="flex items-center gap-2 text-sm">
          <span className="font-bold text-slate-100">{proposerName}</span>
          <ArrowLeftRight className="h-3.5 w-3.5 text-slate-500" aria-hidden />
          <span className="font-bold text-slate-100">{receiverName}</span>
          {unclaimedReceiver && (
            <Badge className="bg-slate-500/15 text-slate-400 ring-slate-500/30">No account</Badge>
          )}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-slate-500">{timeAgo(trade.created_at)}</span>
          <Badge className={status.chip}>{status.label}</Badge>
        </div>
      </div>

      <div className="grid gap-3 px-4 py-3 sm:grid-cols-2">
        <div>
          <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
            {proposerName} sends
          </p>
          <AssetList items={sideA} empty="Nothing" />
        </div>
        <div className="sm:border-l sm:border-slate-800 sm:pl-3">
          <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
            {receiverName} sends
          </p>
          <AssetList items={sideB} empty="Nothing" />
        </div>
      </div>

      {trade.rationale && (
        <div className="mx-4 mb-3 flex gap-2 rounded-lg bg-slate-950/50 px-3 py-2 text-sm text-slate-300 ring-1 ring-slate-800">
          <MessageSquare className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-500" aria-hidden />
          <p className="whitespace-pre-wrap">{trade.rationale}</p>
        </div>
      )}

      {voting && (
        <div className="space-y-2.5 border-t border-slate-800 bg-slate-950/40 px-4 py-3">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
            Both managers agreed — the league decides
          </p>
          <VoteProgress
            approvals={approvals} vetoes={vetoes}
            needApprove={needApprove} needVeto={needVeto}
          />
          <div className="flex flex-wrap items-center gap-2">
            {isParty ? (
              <span className="text-xs text-slate-500">
                You're in this trade, so you don't vote on it.
              </span>
            ) : (
              <>
                <Button
                  variant={myVote?.approve === true ? 'primary' : 'neutral'}
                  busy={busy}
                  onClick={() => onVote(trade, true)}
                >
                  <ThumbsUp className="h-3.5 w-3.5" /> Approve
                </Button>
                <Button
                  variant={myVote?.approve === false ? 'danger' : 'neutral'}
                  busy={busy}
                  onClick={() => onVote(trade, false)}
                >
                  <ThumbsDown className="h-3.5 w-3.5" /> Veto
                </Button>
                <span className="text-xs text-slate-500">
                  {myVote
                    ? `You voted to ${myVote.approve ? 'approve' : 'veto'} — click the other to change it.`
                    : 'You have not voted.'}
                </span>
              </>
            )}
          </div>
        </div>
      )}

      {(pending || isCommish) && (
        <div className="flex flex-wrap items-center gap-2 border-t border-slate-800 bg-slate-950/40 px-4 py-2.5">
          {pending && isReceiver && (
            <>
              <Button variant="primary" busy={busy} onClick={() => onAction(trade, 'accept')}>
                <Check className="h-3.5 w-3.5" /> Accept
              </Button>
              <Button variant="neutral" busy={busy} onClick={() => onAction(trade, 'reject')}>
                <X className="h-3.5 w-3.5" /> Reject
              </Button>
            </>
          )}
          {pending && isProposer && (
            <span className="text-xs text-slate-500">
              {unclaimedReceiver
                ? `${receiverName} has no account yet — settle this yourself or as commissioner.`
                : `Waiting on ${receiverName}…`}
            </span>
          )}
          {pending && !isReceiver && !isProposer && !isCommish && (
            <span className="text-xs text-slate-500">Awaiting the receiving manager.</span>
          )}

          {isCommish && (
            <div className="ml-auto flex flex-wrap items-center gap-2">
              <span className="flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-amber-400">
                <ShieldAlert className="h-3 w-3" aria-hidden /> Commissioner
              </span>
              {trade.status !== 'completed' && (
                <Button variant="neutral" busy={busy} onClick={() => onAction(trade, 'complete')}>
                  <Gavel className="h-3.5 w-3.5" /> Force complete
                </Button>
              )}
              {trade.status !== 'vetoed' && (
                <Button variant="neutral" busy={busy} onClick={() => onAction(trade, 'veto')}>
                  Veto
                </Button>
              )}
              <Button variant="danger" busy={busy} onClick={() => onAction(trade, 'delete')}>
                <Trash2 className="h-3.5 w-3.5" /> Delete
              </Button>
            </div>
          )}
        </div>
      )}
    </Card>
  )
}

/* ══════════════════════════════════════════════════════════════════════════
   Main
   ══════════════════════════════════════════════════════════════════════════ */
export default function TradeTracker({ league, membership, members, teams, toast, onDataChanged }) {
  const players = usePlayers(league.id)
  const me = membership.profile_id
  const [trades, setTrades] = useState([])
  const [votes, setVotes] = useState([])
  const [rosters, setRosters] = useState([])
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState('pending')
  const [builderOpen, setBuilderOpen] = useState(false)
  const [busyId, setBusyId] = useState(null)

  // A team key, not a profile id — the counterparty may have no account.
  const [receiverKey, setReceiverKey] = useState('')
  const [sideA, setSideA] = useState([])
  const [sideB, setSideB] = useState([])
  const [rationale, setRationale] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const myTeam = useMemo(() => findTeam(teams, { profileId: me }), [teams, me])
  // Every team in the league except mine — including the ones nobody has
  // registered for yet. Filtering this down to accounts is what made the
  // dropdown empty in a 12-team league with one signup.
  const opponents = useMemo(
    () => teams.filter((t) => t.key !== myTeam?.key),
    [teams, myTeam]
  )
  const receiverTeam = useMemo(
    () => opponents.find((t) => t.key === receiverKey) ?? null,
    [opponents, receiverKey]
  )

  /* Who owns whom ----------------------------------------------------------
     A trade can only move players the sending team actually rosters, so each
     side of the builder searches that team's roster rather than the whole
     league. Null means "no synced roster for this team" — the picker then falls
     back to the full universe rather than offering an empty list. */
  const votesByTrade = useMemo(() => {
    const map = {}
    for (const v of votes) (map[v.trade_id] ??= []).push(v)
    return map
  }, [votes])

  const rosterByTeam = useMemo(() => {
    const map = new Map()
    for (const r of rosters) {
      if (!map.has(r.espn_team_id)) map.set(r.espn_team_id, new Set())
      map.get(r.espn_team_id).add(r.espn_player_id)
    }
    return map
  }, [rosters])

  const rosterIdsFor = useCallback(
    (team) => (team?.espn_team_id != null ? rosterByTeam.get(team.espn_team_id) ?? null : null),
    [rosterByTeam]
  )
  const myRosterIds = useMemo(() => rosterIdsFor(myTeam), [rosterIdsFor, myTeam])
  const theirRosterIds = useMemo(() => rosterIdsFor(receiverTeam), [rosterIdsFor, receiverTeam])

  /* League rule: at most MAX_OWN_PICKS_TRADED of your own picks, ever. --------
     `committed` is what earlier trades already spent; `pending` is what this
     draft of the builder would add on top. */
  const committedPicks = useMemo(
    () => (myTeam ? ownPicksTradedAway({ teams, trades, teamKey: myTeam.key }) : 0),
    [teams, trades, myTeam]
  )
  const buildersOwnPicks = useMemo(
    () => sideA.filter((a) =>
      a.item_type === 'pick' &&
      // Unspecified origin means your own pick, which is what people mean when
      // they do not fill it in.
      (!a.pick_original_team_key || a.pick_original_team_key === myTeam?.key)
    ).length,
    [sideA, myTeam]
  )
  const picksLeft = MAX_OWN_PICKS_TRADED - committedPicks - buildersOwnPicks

  const load = useCallback(async () => {
    // The embedded select pulls every asset with its trade, so the feed never
    // N+1s across trade_items. Rosters come too: the builder only offers players
    // a team actually owns, which needs espn_rosters.
    const [tradesRes, rostersRes, votesRes] = await Promise.all([
      supabase.from('trades').select('*, trade_items(*)')
        .eq('league_id', league.id).order('created_at', { ascending: false }),
      supabase.from('espn_rosters').select('espn_team_id, espn_player_id, season')
        .eq('league_id', league.id),
      // No league filter needed: RLS scopes trade_votes to trades you can see.
      supabase.from('trade_votes').select('*'),
    ])
    if (tradesRes.error) toast.error(tradesRes.error.message)
    else setTrades(tradesRes.data ?? [])
    if (votesRes.error) toast.error(votesRes.error.message)
    else setVotes(votesRes.data ?? [])

    if (rostersRes.error) toast.error(rostersRes.error.message)
    else {
      const all = rostersRes.data ?? []
      const latest = all.length ? Math.max(...all.map((r) => r.season)) : null
      setRosters(all.filter((r) => r.season === latest))
    }
    setLoading(false)
  }, [toast, league.id])

  useEffect(() => { load() }, [load])

  function resetBuilder() {
    setReceiverKey('')
    setSideA([])
    setSideB([])
    setRationale('')
  }

  /** Turn a builder row into a trade_items insert, or throw a readable error. */
  function toRow(asset, side, tradeId) {
    const base = { trade_id: tradeId, side, item_type: asset.item_type }
    if (asset.item_type === 'player') {
      if (!asset.player_name.trim()) throw new Error('Every player asset needs a name.')
      return {
        ...base,
        player_name: asset.player_name.trim(),
        player_position: asset.player_position,
        // Null when typed free-hand. The name is always the display truth;
        // this is only the join key back to espn_players when we have one.
        espn_player_id: asset.espn_player_id ?? null,
      }
    }
    if (asset.item_type === 'faab') {
      const amt = Number(asset.faab_amount)
      if (!Number.isFinite(amt) || amt <= 0) throw new Error('FAAB must be a positive number.')
      return { ...base, faab_amount: Math.round(amt) }
    }
    const origin = teams.find((t) => t.key === asset.pick_original_team_key) ?? null
    return {
      ...base,
      pick_year: Number(asset.pick_year),
      pick_round: Number(asset.pick_round),
      // Whichever identity that team has. Both columns null means "unspecified",
      // which lib/teams reads as the sender's own pick.
      pick_original_owner_id: origin?.profile_id ?? null,
      pick_original_espn_team_id: origin?.profile_id ? null : origin?.espn_team_id ?? null,
    }
  }

  /**
   * Tell the receiving manager by email. Never throws, never blocks: the trade
   * is already saved, and "your trade failed" would be a lie if only the mail
   * did. A skip (unclaimed team, notifications off, no address) is silent by
   * design — those are expected, not errors.
   */
  async function notifyReceiver(tradeId, team) {
    try {
      const { data, error } = await supabase.functions.invoke('notify-trade', {
        body: { trade_id: tradeId },
      })
      if (error) throw error
      if (data && data.ok === false) {
        toast.error(
          `Trade saved, but the email to ${team.team_name} failed: ` +
          `${data.detail || data.error}`
        )
      }
    } catch (err) {
      toast.error(`Trade saved, but the notification email failed: ${err.message}`)
    }
  }

  async function submitTrade(e) {
    e.preventDefault()
    if (!receiverTeam) return toast.error('Pick a team to trade with.')
    if (sideA.length === 0 && sideB.length === 0) {
      return toast.error('A trade needs at least one asset on one side.')
    }

    /* ── League rules on picks ───────────────────────────────────────────────
       Enforced here as well as in the UI. The year select only offers legal
       years, but a stale builder left open across New Year would otherwise
       submit last season's pick. */
    const badYear = [...sideA, ...sideB].find(
      (a) => a.item_type === 'pick' && !PICK_YEARS.includes(Number(a.pick_year))
    )
    if (badYear) {
      return toast.error(
        `Only ${PICK_YEARS.join(' and ')} picks can be traded — league rule.`
      )
    }
    if (buildersOwnPicks > 0 && picksLeft < 0) {
      return toast.error(
        `League rule: you can only trade ${MAX_OWN_PICKS_TRADED} of your own picks. ` +
        `You have already committed ${committedPicks}.`
      )
    }

    setSubmitting(true)
    let tradeId = null
    try {
      const rows = [
        ...sideA.map((a) => toRow(a, 'A', null)),
        ...sideB.map((a) => toRow(a, 'B', null)),
      ]

      const { data: trade, error: tradeErr } = await supabase
        .from('trades')
        .insert({
          league_id: league.id,
          proposer_id: me,
          // Exactly one of these is set — trades_receiver_one_of enforces it.
          receiver_id: receiverTeam.profile_id ?? null,
          receiver_espn_team_id: receiverTeam.profile_id ? null : receiverTeam.espn_team_id,
          rationale: rationale.trim() || null,
          status: 'pending',
        })
        .select()
        .single()
      if (tradeErr) throw tradeErr
      tradeId = trade.id

      const { error: itemsErr } = await supabase
        .from('trade_items')
        .insert(rows.map((r) => ({ ...r, trade_id: tradeId })))
      if (itemsErr) throw itemsErr

      // ⚠️ DELIBERATELY NOT AUDITED. The log is a record of what HAPPENED to
      // the league, not of every offer made. Most proposals never become
      // anything, and logging them buried the entries that matter.

      toast.success(`Trade proposed to ${receiverTeam.team_name}.`)

      // ⚠️ AFTER the trade is committed, and deliberately not inside the try
      // that rolls it back. The function always returns 200 with a reason, so
      // the only thing that can go wrong here is the network — and a failed
      // email must never delete a successful trade.
      notifyReceiver(tradeId, receiverTeam)

      setBuilderOpen(false)
      resetBuilder()
      setTab('pending')
      await load()
      onDataChanged?.()
    } catch (err) {
      // The two inserts are not one transaction from the client. If the header
      // landed but the assets did not, roll the header back by hand — an empty
      // trade in the feed is worse than no trade.
      if (tradeId) await supabase.from('trades').delete().eq('id', tradeId)
      toast.error(err.message)
    } finally {
      setSubmitting(false)
    }
  }

  /** Both party names for a trade, for audit details and toasts. */
  const partyNames = (trade) => ({
    proposer: findTeam(teams, { profileId: trade.proposer_id })?.team_name ?? 'Unknown',
    receiver: findTeam(teams, {
      profileId: trade.receiver_id,
      espnTeamId: trade.receiver_espn_team_id,
    })?.team_name ?? 'Unknown',
  })

  /**
   * Cast a league vote.
   *
   * ⚠️ THE THRESHOLD CHECK IS SERVER-SIDE, in cast_trade_vote(). Counting here
   * and flipping the status from the client would race: two managers voting at
   * the same moment can both read 4 approvals, and neither would complete the
   * trade. The RPC votes and decides in one transaction and returns the
   * resulting status.
   */
  async function handleVote(trade, approve) {
    setBusyId(trade.id)
    try {
      const { data, error } = await supabase.rpc('cast_trade_vote', {
        p_trade: trade.id,
        p_approve: approve,
      })
      if (error) throw error
      if (data === 'completed') toast.success('That vote approved the trade.')
      else if (data === 'vetoed') toast.success('That vote vetoed the trade.')
      else toast.success(approve ? 'Voted to approve.' : 'Voted to veto.')
      await load()
      onDataChanged?.()
    } catch (err) {
      toast.error(err.message)
    } finally {
      setBusyId(null)
    }
  }

  async function handleAction(trade, action) {
    const CONFIRM = {
      veto: 'Veto this trade? Both managers will see it as vetoed.',
      delete: 'Delete this trade permanently? This cannot be undone.',
      complete: 'Force this trade through as completed?',
    }
    if (CONFIRM[action] && !window.confirm(CONFIRM[action])) return

    setBusyId(trade.id)
    try {
      if (action === 'delete') {
        const { error } = await supabase.from('trades').delete().eq('id', trade.id)
        if (error) throw error
        await logAudit({
          leagueId: league.id, actorId: me, action: AUDIT_ACTIONS.TRADE_DELETED,
          entityType: 'trade', entityId: trade.id,
          details: partyNames(trade),
        })
        toast.success('Trade deleted.')
      } else {
        // `audit: null` = a step along the way, not an outcome. Accepting only
        // opens the league vote and declining ends a private negotiation —
        // neither changed anything about the league, so neither is logged.
        const NEXT = {
          accept:   { status: 'accepted',  audit: null },
          reject:   { status: 'rejected',  audit: null },
          complete: { status: 'completed', audit: AUDIT_ACTIONS.TRADE_COMPLETED },
          veto:     { status: 'vetoed',    audit: AUDIT_ACTIONS.TRADE_VETOED },
        }[action]

        const { error } = await supabase
          .from('trades')
          .update({ status: NEXT.status, resolved_by: me })
          .eq('id', trade.id)
        if (error) throw error

        if (NEXT.audit) {
          await logAudit({
            leagueId: league.id, actorId: me, action: NEXT.audit,
            entityType: 'trade', entityId: trade.id,
            details: {
              ...partyNames(trade),
              by_commissioner: membership.role === 'commissioner' && trade.receiver_id !== me,
            },
          })
        }
        toast.success(
          NEXT.status === 'accepted'
            ? 'Accepted — the league votes on it now.'
            : `Trade ${NEXT.status}.`
        )
      }
      await load()
      onDataChanged?.()
    } catch (err) {
      toast.error(err.message)
    } finally {
      setBusyId(null)
    }
  }

  // 'accepted' means the league is voting, so it belongs with the live trades,
  // not the settled ones.
  const openTrades = trades.filter((t) => t.status === 'pending' || t.status === 'accepted')
  const settledTrades = trades.filter(
    (t) => t.status !== 'pending' && t.status !== 'accepted'
  )
  const shown = tab === 'pending' ? openTrades : settledTrades

  // Waiting on YOU: a trade you must answer, or a vote you have not cast.
  const myPendingCount = trades.filter((t) => {
    if (t.status === 'pending') return t.receiver_id === me
    if (t.status !== 'accepted') return false
    if (t.proposer_id === me || t.receiver_id === me) return false
    return !(votesByTrade[t.id] ?? []).some((v) => v.voter_id === me)
  }).length

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-black tracking-tight text-slate-100">Trades</h2>
          <p className="text-sm text-slate-500">
            {myPendingCount > 0
              ? `${myPendingCount} trade${myPendingCount === 1 ? '' : 's'} waiting on you.`
              : `Both managers agree, then ${league.trade_votes_to_approve ?? 5} approvals pass it — ${league.trade_votes_to_veto ?? 9} vetoes kill it.`}
          </p>
        </div>
        <Button variant="primary" onClick={() => setBuilderOpen(true)}>
          <Plus className="h-4 w-4" /> Propose trade
        </Button>
      </div>

      <div className="flex gap-1 rounded-lg bg-slate-900/60 p-1 ring-1 ring-slate-800">
        {[
          ['pending', 'Open', openTrades.length],
          ['settled', 'Settled', settledTrades.length],
        ].map(([key, label, count]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={cx(
              'flex-1 rounded-md px-3 py-1.5 text-sm font-semibold transition-colors',
              tab === key ? 'bg-slate-800 text-slate-100' : 'text-slate-400 hover:text-slate-200'
            )}
          >
            {label} <span className="text-slate-500">({count})</span>
          </button>
        ))}
      </div>

      {loading ? (
        <Loading label="Loading trades…" />
      ) : shown.length === 0 ? (
        <Card>
          <EmptyState
            icon={Handshake}
            title={tab === 'pending' ? 'No open trades' : 'Nothing settled yet'}
          >
            {tab === 'pending'
              ? 'Propose one and it shows up here — first for the other manager, then for the league to vote on.'
              : 'Approved, declined and vetoed trades land here.'}
          </EmptyState>
        </Card>
      ) : (
        <div className="space-y-3">
          {shown.map((t) => (
            <TradeCard
              key={t.id}
              trade={t}
              me={me}
              isCommish={membership.role === 'commissioner'}
              teams={teams}
              onAction={handleAction}
              busyId={busyId}
              votes={votesByTrade[t.id] ?? []}
              needApprove={league.trade_votes_to_approve ?? 5}
              needVeto={league.trade_votes_to_veto ?? 9}
              onVote={handleVote}
            />
          ))}
        </div>
      )}

      <Modal
        open={builderOpen}
        onClose={() => setBuilderOpen(false)}
        title="Propose a trade"
        wide
        footer={
          <>
            <Button variant="ghost" onClick={() => setBuilderOpen(false)}>Cancel</Button>
            <Button variant="primary" busy={submitting} onClick={submitTrade}>Send proposal</Button>
          </>
        }
      >
        <form onSubmit={submitTrade} className="space-y-4">
          <Field
            label="Trade with"
            hint={
              receiverTeam && !receiverTeam.claimed
                ? 'This team has no account yet — you or the commissioner will settle the trade.'
                : undefined
            }
          >
            <Select value={receiverKey} onChange={(e) => setReceiverKey(e.target.value)} required>
              <option value="">Select a team…</option>
              {opponents.map((t) => (
                <option key={t.key} value={t.key}>
                  {t.team_name}{t.claimed ? '' : ' — no account yet'}
                </option>
              ))}
            </Select>
          </Field>

          {opponents.length === 0 && (
            <p className="rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-300 ring-1 ring-amber-500/30">
              No other teams yet. Connect ESPN and run a sync in League Settings to
              pull in the rest of the league — you do not have to wait for anyone
              to register.
            </p>
          )}

          {/* The pick rules, stated where they bite. */}
          <div className={cx(
            'rounded-lg px-3 py-2 text-xs ring-1',
            picksLeft < 0
              ? 'bg-rose-500/10 text-rose-300 ring-rose-500/30'
              : 'bg-slate-900/60 text-slate-400 ring-slate-800'
          )}>
            <span className="font-semibold text-slate-300">Pick rules:</span>{' '}
            only {PICK_YEARS.join(' and ')} picks are tradeable, and you can trade at
            most {MAX_OWN_PICKS_TRADED} of your own.{' '}
            {picksLeft < 0 ? (
              <span className="font-semibold">
                That is {Math.abs(picksLeft)} too many — you have already committed{' '}
                {committedPicks}.
              </span>
            ) : (
              <span className="text-slate-500">
                {committedPicks} committed in other trades · {picksLeft} left after this one.
              </span>
            )}
          </div>

          {!players.loading && players.players.length === 0 && (
            <p className="rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-300 ring-1 ring-amber-500/30">
              No ESPN player data synced yet — player names are free text for now.
              Run a sync from League Settings to turn this into a searchable list
              with positions, teams and injury flags.
            </p>
          )}

          <div className="grid gap-3 lg:grid-cols-2">
            <SideBuilder
              heading="You send"
              subheading={`Leaves ${membership.team_name}`}
              assets={sideA}
              setAssets={setSideA}
              teams={teams}
              players={players}
              rosterIds={myRosterIds}
              rosterLabel={myTeam?.team_name ?? 'your'}
              rosterMissing={!myRosterIds && players.players.length > 0}
            />
            <SideBuilder
              heading="You receive"
              subheading={
                receiverTeam ? `Leaves ${receiverTeam.team_name}` : 'Select a team above'
              }
              assets={sideB}
              setAssets={setSideB}
              teams={teams}
              players={players}
              rosterIds={theirRosterIds}
              rosterLabel={receiverTeam?.team_name ?? 'their'}
              rosterMissing={!!receiverTeam && !theirRosterIds && players.players.length > 0}
            />
          </div>

          <Field label="Rationale" hint="Why this deal makes sense. Visible to the whole league.">
            <Textarea
              rows={3}
              value={rationale}
              onChange={(e) => setRationale(e.target.value)}
              placeholder="I'm thin at RB after the injury and you need WR depth for the playoff run…"
            />
          </Field>
        </form>
      </Modal>
    </div>
  )
}
