import { useState } from 'react'
import {
  ShieldCheck, Link2, Unlink, RefreshCw, Copy, Check, RotateCw, Users,
  Lock, AlertTriangle, ExternalLink, Save,
} from 'lucide-react'
import { supabase } from '../supabaseClient'
import { invalidatePlayers } from '../lib/usePlayers'
import { timeAgo } from '../lib/constants'
import { appLink, SHARE_TEXT } from '../lib/share'
import { Badge, Button, Card, Field, Input, Modal, ShareButton, cx } from './ui'

/**
 * Turn a functions.invoke() failure into something that names the actual cause.
 *
 * ⚠️ supabase-js throws FunctionsHttpError for ANY non-2xx, and its `.message`
 * is the fixed string "Edge Function returned a non-2xx status code" — the same
 * text whether ESPN rejected your cookies, the league id is missing, or a
 * table upsert failed. The function's real JSON body is on `err.context`, an
 * unread Response. Read it, or every server-side failure looks identical.
 */
async function describeInvokeError(err) {
  const res = err?.context
  if (res && typeof res.clone === 'function') {
    try {
      const body = await res.clone().json()
      if (body?.error) return body.error
    } catch { /* not JSON — fall through */ }
    try {
      const text = await res.clone().text()
      if (text.trim()) return `HTTP ${res.status}: ${text.slice(0, 300)}`
    } catch { /* body already consumed */ }
    if (res.status) return `Edge Function returned HTTP ${res.status} with no body.`
  }
  // No response at all — the request never landed. THIS is the only case where
  // "is it deployed?" is the right question; a non-2xx proves that it is.
  if (/Failed to send|Failed to fetch|NetworkError/i.test(err?.message ?? '')) {
    return `${err.message} — is sync-espn deployed, and is VITE_SUPABASE_URL the bare origin?`
  }
  return err?.message ?? String(err)
}

export default function LeagueSettings({ league, membership, members, toast, onChanged }) {
  const isCommish = membership.role === 'commissioner'

  const [espnLeagueId, setEspnLeagueId] = useState(league.espn_league_id ?? '')
  const [savingId, setSavingId] = useState(false)

  const [credsOpen, setCredsOpen] = useState(false)
  const [s2, setS2] = useState('')
  const [swid, setSwid] = useState('')
  const [savingCreds, setSavingCreds] = useState(false)

  const [syncing, setSyncing] = useState(false)
  const [copied, setCopied] = useState(false)
  const [rotating, setRotating] = useState(false)

  async function saveLeagueId(e) {
    e.preventDefault()
    setSavingId(true)
    try {
      const { error } = await supabase
        .from('leagues')
        .update({ espn_league_id: espnLeagueId.trim() || null })
        .eq('id', league.id)
      if (error) throw error
      toast.success('ESPN league id saved.')
      await onChanged()
    } catch (err) {
      toast.error(err.message)
    } finally {
      setSavingId(false)
    }
  }

  async function saveCreds(e) {
    e.preventDefault()
    if (!s2.trim() || !swid.trim()) return toast.error('Both values are required.')
    setSavingCreds(true)
    try {
      // Goes through the SECURITY DEFINER function, not a direct insert — the
      // client has no privilege on league_espn_credentials at all.
      const { error } = await supabase.rpc('set_espn_credentials', {
        p_league: league.id,
        p_s2: s2.trim(),
        p_swid: swid.trim(),
      })
      if (error) throw error
      // Clear immediately. There is no reason for these to sit in React state
      // one render longer than the request needs them.
      setS2('')
      setSwid('')
      setCredsOpen(false)
      toast.success('ESPN connected. Run a sync to pull your league.')
      await onChanged()
    } catch (err) {
      toast.error(err.message)
    } finally {
      setSavingCreds(false)
    }
  }

  async function disconnect() {
    if (!window.confirm('Disconnect ESPN? Synced data stays, but you cannot refresh it until you reconnect.')) return
    try {
      const { error } = await supabase.rpc('clear_espn_credentials', { p_league: league.id })
      if (error) throw error
      toast.success('ESPN disconnected.')
      await onChanged()
    } catch (err) {
      toast.error(err.message)
    }
  }

  async function sync() {
    setSyncing(true)
    try {
      const { data, error } = await supabase.functions.invoke('sync-espn', {
        body: { league_id: league.id },
      })
      if (error) throw error
      if (data?.error) throw new Error(data.error)

      invalidatePlayers()
      if (data?.warning) {
        toast.error(`Players synced, rosters skipped — ${data.warning}`)
      } else {
        toast.success(
          `Synced ${data.players} players, ${data.teams} teams, ${data.rosters} roster slots.`
        )
      }
      await onChanged()
    } catch (err) {
      toast.error(await describeInvokeError(err))
    } finally {
      setSyncing(false)
    }
  }

  async function copyCode() {
    try {
      await navigator.clipboard.writeText(league.invite_code)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      toast.error('Could not copy — select the code and copy it manually.')
    }
  }

  async function rotateCode() {
    if (!window.confirm('Generate a new invite code? The old one stops working immediately.')) return
    setRotating(true)
    try {
      const { error } = await supabase.rpc('rotate_invite_code', { p_league: league.id })
      if (error) throw error
      toast.success('New invite code generated.')
      await onChanged()
    } catch (err) {
      toast.error(err.message)
    } finally {
      setRotating(false)
    }
  }

  if (!isCommish) {
    return (
      <Card>
        <div className="flex flex-col items-center gap-2 px-6 py-14 text-center">
          <Lock className="h-8 w-8 text-slate-600" aria-hidden />
          <p className="text-sm font-semibold text-slate-300">Commissioner only</p>
          <p className="max-w-sm text-sm text-slate-500">
            {members.find((m) => m.role === 'commissioner')?.team_name ?? 'Your commissioner'} manages
            the ESPN connection and invites for {league.name}.
          </p>
        </div>
      </Card>
    )
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-black tracking-tight text-slate-100">League settings</h2>
        <p className="text-sm text-slate-500">{league.name} · {league.season}</p>
      </div>

      {/* ── Invite ─────────────────────────────────────────────────────────── */}
      <Card className="p-5">
        <div className="mb-3 flex items-center gap-2">
          <Users className="h-4 w-4 text-slate-500" aria-hidden />
          <h3 className="text-sm font-bold text-slate-100">Invite managers</h3>
        </div>
        <p className="mb-3 text-sm text-slate-400">
          The league-wide code. They register, pick “Join with a code”, and name their
          own team — use it for anyone who is not already an ESPN team.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <code className="flex-1 rounded-lg bg-slate-950/70 px-4 py-2.5 text-center text-lg font-bold tracking-[0.3em] text-emerald-300 ring-1 ring-slate-800">
            {league.invite_code}
          </code>
          <Button variant="neutral" onClick={copyCode}>
            {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
            {copied ? 'Copied' : 'Copy'}
          </Button>
          <ShareButton
            variant="neutral"
            label="Send link and code"
            toast={toast}
            url={appLink()}
            text={SHARE_TEXT.joinCode({ league: league.name, code: league.invite_code })}
          />
          <Button variant="ghost" busy={rotating} onClick={rotateCode}>
            <RotateCw className="h-4 w-4" /> New code
          </Button>
        </div>
        {/* Points at the better door. This code makes them type a team name;
            the per-team link does not, and cannot land them on the wrong one. */}
        <p className="mt-3 text-xs text-slate-500">
          For managers who already have an ESPN team, send their personal link from{' '}
          <span className="text-slate-400">Profile &rarr; Managers</span> instead — it
          binds them to the right team with nothing to type.
        </p>
      </Card>

      {/* ── ESPN ───────────────────────────────────────────────────────────── */}
      <Card className="p-5">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Link2 className="h-4 w-4 text-slate-500" aria-hidden />
            <h3 className="text-sm font-bold text-slate-100">ESPN connection</h3>
          </div>
          {league.espn_connected ? (
            <Badge className="bg-emerald-500/15 text-emerald-300 ring-emerald-500/30">
              <ShieldCheck className="h-3 w-3" aria-hidden /> Connected
            </Badge>
          ) : (
            <Badge className="bg-slate-500/15 text-slate-300 ring-slate-500/30">Not connected</Badge>
          )}
        </div>

        <form onSubmit={saveLeagueId} className="mb-4 flex flex-wrap items-end gap-2">
          <Field
            label="ESPN league id"
            className="flex-1 min-w-[12rem]"
            hint="The number in your ESPN league URL."
          >
            <Input
              value={espnLeagueId}
              onChange={(e) => setEspnLeagueId(e.target.value.replace(/\D/g, ''))}
              placeholder="123456"
              inputMode="numeric"
            />
          </Field>
          <Button
            type="submit"
            variant="neutral"
            busy={savingId}
            disabled={espnLeagueId.trim() === (league.espn_league_id ?? '')}
          >
            <Save className="h-4 w-4" /> Save
          </Button>
        </form>

        <div className="flex flex-wrap items-center gap-2 border-t border-slate-800 pt-4">
          <Button variant={league.espn_connected ? 'neutral' : 'primary'} onClick={() => setCredsOpen(true)}>
            <Link2 className="h-4 w-4" />
            {league.espn_connected ? 'Update credentials' : 'Connect ESPN'}
          </Button>
          {league.espn_connected && (
            <>
              <Button variant="primary" busy={syncing} onClick={sync}>
                <RefreshCw className={cx('h-4 w-4', syncing && 'animate-spin')} /> Sync now
              </Button>
              <Button variant="ghost" onClick={disconnect}>
                <Unlink className="h-4 w-4" /> Disconnect
              </Button>
            </>
          )}
        </div>

        {league.last_sync_at && (
          <p className="mt-3 text-xs text-slate-500">
            Last sync {timeAgo(league.last_sync_at)}
            {league.last_sync_status && (
              <span className={cx(
                'ml-1',
                /failed|skipped/i.test(league.last_sync_status) ? 'text-amber-400' : 'text-slate-500'
              )}>
                — {league.last_sync_status}
              </span>
            )}
          </p>
        )}
      </Card>

      {/* ── Members ────────────────────────────────────────────────────────── */}
      <Card>
        <div className="border-b border-slate-800 px-4 py-3">
          <h3 className="text-sm font-bold text-slate-100">
            Members <span className="font-normal text-slate-500">({members.length})</span>
          </h3>
        </div>
        <div className="divide-y divide-slate-800">
          {members.map((m) => (
            <div key={m.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-slate-100">
                  {m.team_name}
                  {m.profile_id === membership.profile_id && (
                    <span className="ml-1.5 text-xs text-slate-500">(you)</span>
                  )}
                </p>
                <p className="text-xs text-slate-500">Joined {timeAgo(m.joined_at)}</p>
              </div>
              {m.role === 'commissioner' && (
                <Badge className="bg-amber-500/15 text-amber-300 ring-amber-500/30">
                  <ShieldCheck className="h-3 w-3" aria-hidden /> Commissioner
                </Badge>
              )}
            </div>
          ))}
        </div>
      </Card>

      {/* ── Credential modal ───────────────────────────────────────────────── */}
      <Modal
        open={credsOpen}
        onClose={() => { setCredsOpen(false); setS2(''); setSwid('') }}
        title="Connect ESPN"
        footer={
          <>
            <Button variant="ghost" onClick={() => { setCredsOpen(false); setS2(''); setSwid('') }}>
              Cancel
            </Button>
            <Button variant="primary" busy={savingCreds} onClick={saveCreds}>Save credentials</Button>
          </>
        }
      >
        <form onSubmit={saveCreds} className="space-y-3">
          <div className="flex gap-2 rounded-lg bg-emerald-500/10 px-3 py-2.5 text-xs text-emerald-200 ring-1 ring-emerald-500/30">
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" aria-hidden />
            <div className="space-y-1">
              <p className="font-semibold">These never reach a browser.</p>
              <p className="text-emerald-300/80">
                They're stored write-only — no policy lets anyone read them back, including you.
                Only the server-side sync function can use them, which is also why ESPN's missing
                CORS headers aren't a problem.
              </p>
            </div>
          </div>

          <div className="flex gap-2 rounded-lg bg-amber-500/10 px-3 py-2.5 text-xs text-amber-200 ring-1 ring-amber-500/30">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" aria-hidden />
            <p>
              These are session cookies for <em>your personal ESPN account</em>, not scoped
              tokens — anyone holding them can act as you on ESPN. They expire every few weeks;
              reconnect here when syncs start failing.
            </p>
          </div>

          <details className="rounded-lg bg-slate-950/60 px-3 py-2 text-xs text-slate-400 ring-1 ring-slate-800">
            <summary className="cursor-pointer font-semibold text-slate-300">
              Where do I find these?
            </summary>
            <ol className="mt-2 list-decimal space-y-1 pl-4">
              <li>
                Open{' '}
                <a
                  href="https://fantasy.espn.com"
                  target="_blank"
                  rel="noreferrer noopener"
                  className="inline-flex items-center gap-0.5 text-emerald-400 hover:underline"
                >
                  fantasy.espn.com <ExternalLink className="h-3 w-3" />
                </a>{' '}
                and sign in.
              </li>
              <li>Open DevTools (F12) → Application → Cookies → <code>https://fantasy.espn.com</code>.</li>
              <li>Copy the values of <code>espn_s2</code> and <code>SWID</code>.</li>
              <li>Paste them below. Braces around SWID are fine either way.</li>
            </ol>
          </details>

          <Field label="espn_s2">
            <Input
              type="password"
              value={s2}
              onChange={(e) => setS2(e.target.value)}
              placeholder="AEB..."
              autoComplete="off"
              spellCheck={false}
              required
            />
          </Field>
          <Field label="SWID">
            <Input
              type="password"
              value={swid}
              onChange={(e) => setSwid(e.target.value)}
              placeholder="{XXXXXXXX-XXXX-...}"
              autoComplete="off"
              spellCheck={false}
              required
            />
          </Field>
          <p className="text-xs text-slate-500">
            Public leagues don't need these — set the league id above and hit Sync.
          </p>
        </form>
      </Modal>
    </div>
  )
}
