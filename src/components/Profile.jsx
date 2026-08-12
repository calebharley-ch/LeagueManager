import { useCallback, useEffect, useState } from 'react'
import {
  Save, ShieldCheck, User, Users, LogOut, Trophy, UserCheck, UserPlus, Link2, Mail,
  MailCheck, Send, Trash2, UserMinus, ShieldPlus, ShieldOff,
} from 'lucide-react'
import { supabase } from '../supabaseClient'
import { timeAgo } from '../lib/constants'
import { Badge, Button, Card, Field, IconButton, Input, Select } from './ui'

// Loose on purpose — the real check is the send failing. This only stops us
// spending an API call on an obvious typo, and gates the Send button.
const looksLikeEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test((s ?? '').trim())

export default function Profile({
  league, membership, members, teams, session, toast, onChanged,
}) {
  const [teamName, setTeamName] = useState(membership.team_name ?? '')
  const [espnTeamId, setEspnTeamId] = useState(
    membership.espn_team_id != null ? String(membership.espn_team_id) : ''
  )
  const [emailOn, setEmailOn] = useState(membership.email_notifications !== false)
  const [busy, setBusy] = useState(false)

  // Invite address book. Keyed by espn_team_id. `invites` is what the server
  // has; `emails` holds unsaved edits so typing does not fight the reload.
  const [invites, setInvites] = useState({})
  const [emails, setEmails] = useState({})
  const [sendingId, setSendingId] = useState(null)
  const [sendingAll, setSendingAll] = useState(false)

  const isCommish = membership.role === 'commissioner'
  const dirty =
    teamName.trim() !== (membership.team_name ?? '') ||
    espnTeamId !== (membership.espn_team_id != null ? String(membership.espn_team_id) : '') ||
    emailOn !== (membership.email_notifications !== false)

  // Teams already spoken for by somebody else — you cannot claim those.
  const takenByOthers = new Set(
    teams
      .filter((t) => t.claimed && t.profile_id !== membership.profile_id && t.espn_team_id != null)
      .map((t) => t.espn_team_id)
  )
  const claimable = teams.filter(
    (t) => t.espn_team_id != null && !takenByOthers.has(t.espn_team_id)
  )

  /* Invites ---------------------------------------------------------------- */
  const loadInvites = useCallback(async () => {
    // RLS restricts this table to the commissioner, so a manager asking would
    // just get an empty list — skip the round trip instead.
    if (!isCommish) return
    const { data, error } = await supabase
      .from('league_invites')
      .select('*')
      .eq('league_id', league.id)
    if (error) { toast.error(error.message); return }
    setInvites(Object.fromEntries((data ?? []).map((r) => [r.espn_team_id, r])))
  }, [isCommish, league.id, toast])

  useEffect(() => { loadInvites() }, [loadInvites])

  /** Draft value wins over the saved one, so typing is never clobbered. */
  const emailFor = (t) => {
    const id = t.espn_team_id
    if (id == null) return ''
    return emails[id] ?? invites[id]?.email ?? ''
  }

  async function sendTo(targetTeams) {
    const targets = targetTeams
      .filter((t) => t.espn_team_id != null && looksLikeEmail(emailFor(t)))
      .map((t) => ({ espn_team_id: t.espn_team_id, email: emailFor(t).trim() }))

    if (targets.length === 0) return toast.error('Enter an email address first.')

    const single = targets.length === 1
    if (single) setSendingId(targets[0].espn_team_id)
    else setSendingAll(true)

    try {
      const { data, error } = await supabase.functions.invoke('send-invite', {
        body: { league_id: league.id, targets },
      })
      if (error) throw error
      if (data?.error) throw new Error(data.error)

      const failed = (data?.results ?? []).filter((r) => !r.ok)
      if (data?.sent > 0) {
        toast.success(`Invite${data.sent === 1 ? '' : 's'} sent to ${data.sent} team${data.sent === 1 ? '' : 's'}.`)
      }
      for (const f of failed) {
        toast.error(`Invite failed: ${f.detail || f.error}`)
      }
      await loadInvites()
    } catch (err) {
      // functions.invoke hides the body on a non-2xx — read it off err.context
      // or every failure reads as the same useless string.
      let msg = err.message
      try {
        const body = await err?.context?.clone?.().json()
        if (body?.error) msg = body.error
      } catch { /* not JSON */ }
      toast.error(msg)
    } finally {
      setSendingId(null)
      setSendingAll(false)
    }
  }

  /** Forget the address for a team nobody has registered for. */
  async function clearInvite(t) {
    if (!window.confirm(
      `Remove ${invites[t.espn_team_id]?.email ?? 'the saved address'} from ${t.team_name}?\n\n` +
      `The invite link already sent stops being tracked, but it keeps working — ` +
      `delete and re-invite only if the address was wrong.`
    )) return
    setSendingId(t.espn_team_id)
    try {
      const { error } = await supabase
        .from('league_invites').delete()
        .eq('league_id', league.id).eq('espn_team_id', t.espn_team_id)
      if (error) throw error
      setEmails((m) => ({ ...m, [t.espn_team_id]: '' }))
      toast.success('Invite cleared.')
      await loadInvites()
    } catch (err) {
      toast.error(err.message)
    } finally {
      setSendingId(null)
    }
  }

  /**
   * Promote a manager to co-commissioner, or step one back down.
   *
   * The database guards this too — a trigger blocks role changes by
   * non-commissioners and refuses to remove the last one. Without that guard
   * the existing "edit your own membership" policy would have let any manager
   * set their own role and take over the league.
   */
  async function setRole(t, role) {
    const promoting = role === 'commissioner'
    if (!window.confirm(
      promoting
        ? `Make ${t.team_name} a commissioner?\n\nThey get everything you can do: ` +
          `ESPN sync, invites, rules, and overriding trades. There is no ranking ` +
          `between commissioners.`
        : `Step ${t.team_name} down to manager?\n\nThey keep their team and their history.`
    )) return
    setSendingId(t.espn_team_id ?? t.key)
    try {
      const { error } = await supabase
        .from('league_members').update({ role }).eq('id', t.member.id)
      if (error) throw error
      toast.success(promoting ? `${t.team_name} is now a commissioner.` : `${t.team_name} is now a manager.`)
      await onChanged?.()
    } catch (err) {
      toast.error(err.message)
    } finally {
      setSendingId(null)
    }
  }

  /** Detach a registered manager from the league. */
  async function removeMember(t) {
    if (!window.confirm(
      `Remove ${t.team_name} from ${league.name}?\n\n` +
      `They lose access immediately and the team goes back to unclaimed, so ` +
      `someone else can be invited to it. Their past trades stay in the feed but ` +
      `will show as an unknown team.\n\nTheir account is not deleted.`
    )) return
    setSendingId(t.espn_team_id ?? t.key)
    try {
      // RLS allows this for the commissioner only, and never on your own row.
      const { error } = await supabase
        .from('league_members').delete().eq('id', t.member.id)
      if (error) throw error
      toast.success(`${t.team_name} removed.`)
      await onChanged?.()
    } catch (err) {
      toast.error(err.message)
    } finally {
      setSendingId(null)
    }
  }

  const pendingWithEmail = teams.filter(
    (t) => !t.claimed && t.espn_team_id != null && looksLikeEmail(emailFor(t))
  )

  async function save(e) {
    e.preventDefault()
    if (!teamName.trim()) return toast.error('Team name cannot be empty.')
    setBusy(true)
    try {
      // Team name lives on the MEMBERSHIP, not the profile — you can be a
      // different team in each league you're in. espn_team_id is what links
      // this account to a synced ESPN team; without it your team shows up
      // twice — once as an unclaimed ESPN team, once as an unlinked account.
      const { error } = await supabase
        .from('league_members')
        .update({
          team_name: teamName.trim(),
          espn_team_id: espnTeamId ? Number(espnTeamId) : null,
          email_notifications: emailOn,
        })
        .eq('id', membership.id)
      if (error) throw error
      toast.success('Saved.')
      await onChanged?.()
    } catch (err) {
      toast.error(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-black tracking-tight text-slate-100">Profile</h2>
        <p className="text-sm text-slate-500">Your identity in {league.name}.</p>
      </div>

      <Card className="p-5">
        <form onSubmit={save} className="space-y-3">
          <Field label="Team name" hint="Only applies to this league.">
            <Input value={teamName} onChange={(e) => setTeamName(e.target.value)} required />
          </Field>

          <Field
            label="Your ESPN team"
            hint={
              membership.espn_team_id == null
                ? 'Link yourself to a synced team so your roster, FAAB and picks are yours.'
                : 'Teams already claimed by another manager are not listed.'
            }
          >
            <Select value={espnTeamId} onChange={(e) => setEspnTeamId(e.target.value)}>
              <option value="">Not linked yet</option>
              {claimable.map((t) => (
                <option key={t.espn_team_id} value={String(t.espn_team_id)}>
                  {t.espn_team_name || t.team_name}
                </option>
              ))}
            </Select>
          </Field>
          <label className="flex cursor-pointer items-start gap-2.5 rounded-lg bg-slate-950/50 px-3 py-2.5 ring-1 ring-slate-800">
            <input
              type="checkbox"
              className="mt-0.5 h-4 w-4 shrink-0 rounded border-slate-600 bg-slate-900 accent-emerald-500"
              checked={emailOn}
              onChange={(e) => setEmailOn(e.target.checked)}
            />
            <span className="min-w-0">
              <span className="flex items-center gap-1.5 text-sm font-semibold text-slate-200">
                <Mail className="h-3.5 w-3.5 text-slate-500" aria-hidden />
                Email me about trades
              </span>
              <span className="mt-0.5 block text-xs text-slate-500">
                Sent to {session.user.email} when a trade is waiting on you. This
                league only.
              </span>
            </span>
          </label>

          <div className="flex flex-wrap items-center gap-3 pt-1">
            <Button type="submit" variant="primary" busy={busy} disabled={!dirty}>
              <Save className="h-4 w-4" /> Save
            </Button>
            <div className="flex items-center gap-2 text-sm text-slate-500">
              <span>Role:</span>
              {isCommish ? (
                <Badge className="bg-amber-500/15 text-amber-300 ring-amber-500/30">
                  <ShieldCheck className="h-3 w-3" aria-hidden /> Commissioner
                </Badge>
              ) : (
                <Badge className="bg-slate-500/15 text-slate-300 ring-slate-500/30">Manager</Badge>
              )}
            </div>
          </div>
        </form>

        <div className="mt-5 space-y-1 border-t border-slate-800 pt-4 text-sm text-slate-500">
          <p className="flex items-center gap-2">
            <User className="h-3.5 w-3.5" aria-hidden /> {session.user.email}
          </p>
          <p className="flex items-center gap-2">
            <Trophy className="h-3.5 w-3.5" aria-hidden />
            {league.name} · {league.season} · joined {timeAgo(membership.joined_at)}
          </p>
        </div>
      </Card>

      {/* Every team in the league, not just the ones with accounts. A team
          without a manager registered is still a team you trade with. */}
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 px-4 py-3">
          <div className="flex items-center gap-2">
            <Users className="h-4 w-4 text-slate-500" aria-hidden />
            <h3 className="text-sm font-bold text-slate-100">
              League teams{' '}
              <span className="font-normal text-slate-500">
                ({teams.filter((t) => t.claimed).length} of {teams.length} registered)
              </span>
            </h3>
          </div>
          {isCommish && pendingWithEmail.length > 0 && (
            <Button
              variant="primary"
              className="py-1 text-xs"
              busy={sendingAll}
              onClick={() => sendTo(pendingWithEmail)}
            >
              <Send className="h-3 w-3" />
              Send {pendingWithEmail.length} invite{pendingWithEmail.length === 1 ? '' : 's'}
            </Button>
          )}
        </div>
        <div className="divide-y divide-slate-800">
          {teams.map((t) => {
            const inv = t.espn_team_id != null ? invites[t.espn_team_id] : null
            const draft = emailFor(t)
            const canInvite = isCommish && !t.claimed && t.espn_team_id != null

            return (
              <div key={t.key} className="px-4 py-2.5">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-slate-100">
                      {t.team_name}
                      {t.profile_id === membership.profile_id && (
                        <span className="ml-1.5 text-xs text-slate-500">(you)</span>
                      )}
                    </p>
                    <p className="text-xs text-slate-500">
                      {t.claimed
                        ? `Joined ${timeAgo(t.member.joined_at)}`
                        : inv?.invited_at
                          ? `Invited ${timeAgo(inv.invited_at)}${inv.send_count > 1 ? ` · ${inv.send_count} times` : ''}`
                          : 'Has not created an account yet'}
                      {t.unlinked && ' · not linked to an ESPN team'}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    {t.role === 'commissioner' && (
                      <Badge className="bg-amber-500/15 text-amber-300 ring-amber-500/30">
                        <ShieldCheck className="h-3 w-3" aria-hidden /> Commissioner
                      </Badge>
                    )}
                    {t.claimed ? (
                      <>
                        <Badge className="bg-emerald-500/15 text-emerald-300 ring-emerald-500/30">
                          <UserCheck className="h-3 w-3" aria-hidden /> Registered
                        </Badge>
                        {/* Never on your own row: RLS forbids it, and a
                            commissioner removing themselves would strand the
                            league with nobody who can administer it. */}
                        {isCommish && t.profile_id !== membership.profile_id && t.member && (
                          <>
                            <IconButton
                              label={
                                t.role === 'commissioner'
                                  ? `Step ${t.team_name} down to manager`
                                  : `Make ${t.team_name} a commissioner`
                              }
                              disabled={sendingId === (t.espn_team_id ?? t.key)}
                              onClick={() =>
                                setRole(t, t.role === 'commissioner' ? 'manager' : 'commissioner')
                              }
                            >
                              {t.role === 'commissioner'
                                ? <ShieldOff className="h-4 w-4" />
                                : <ShieldPlus className="h-4 w-4" />}
                            </IconButton>
                            <IconButton
                              label={`Remove ${t.team_name} from the league`}
                              disabled={sendingId === (t.espn_team_id ?? t.key)}
                              onClick={() => removeMember(t)}
                            >
                              <UserMinus className="h-4 w-4" />
                            </IconButton>
                          </>
                        )}
                      </>
                    ) : inv?.invited_at ? (
                      <Badge className="bg-sky-500/15 text-sky-300 ring-sky-500/30">
                        <MailCheck className="h-3 w-3" aria-hidden /> Invited
                      </Badge>
                    ) : (
                      <Badge className="bg-slate-500/15 text-slate-400 ring-slate-500/30">
                        <UserPlus className="h-3 w-3" aria-hidden /> Invite pending
                      </Badge>
                    )}
                  </div>
                </div>

                {canInvite && (
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <Input
                      type="email"
                      className="h-8 min-w-0 flex-1 py-1 text-xs"
                      placeholder="their@email.com"
                      value={draft}
                      aria-label={`Invite email for ${t.team_name}`}
                      onChange={(e) =>
                        setEmails((m) => ({ ...m, [t.espn_team_id]: e.target.value }))
                      }
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') { e.preventDefault(); sendTo([t]) }
                      }}
                    />
                    <Button
                      variant="neutral"
                      className="h-8 shrink-0 py-1 text-xs"
                      busy={sendingId === t.espn_team_id}
                      disabled={!looksLikeEmail(draft) || sendingAll}
                      onClick={() => sendTo([t])}
                    >
                      <Send className="h-3 w-3" />
                      {inv?.invited_at ? 'Resend' : 'Send invite'}
                    </Button>
                    {inv && (
                      <IconButton
                        label={`Clear invite for ${t.team_name}`}
                        disabled={sendingAll || sendingId === t.espn_team_id}
                        onClick={() => clearInvite(t)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </IconButton>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
        {isCommish && teams.some((t) => !t.claimed) && (
          <div className="flex items-center gap-2 border-t border-slate-800 bg-slate-950/40 px-4 py-2.5 text-xs text-slate-500">
            <Link2 className="h-3.5 w-3.5 shrink-0" aria-hidden />
            Share the invite code from League Settings. Unregistered teams still
            appear everywhere and can be traded with in the meantime.
          </div>
        )}
      </Card>

      <Button variant="neutral" onClick={() => supabase.auth.signOut()}>
        <LogOut className="h-4 w-4" /> Sign out
      </Button>
    </div>
  )
}
