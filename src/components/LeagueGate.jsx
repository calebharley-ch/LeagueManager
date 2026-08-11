import { useState } from 'react'
import { Trophy, Plus, LogIn, LogOut, ArrowRight, ShieldCheck, Users } from 'lucide-react'
import { supabase } from '../supabaseClient'
import { SEASONS } from '../lib/constants'
import { Badge, Button, Card, Field, Input, Select, cx } from './ui'

/**
 * Shown after sign-in until a league is active.
 *
 * Both actions go through SECURITY DEFINER functions rather than direct
 * inserts. create_league() makes the league AND the commissioner membership in
 * one transaction — done as two client calls, a failure between them strands a
 * league with no members, which is invisible even to its creator because every
 * SELECT policy requires membership. join_league() exists because a non-member
 * cannot SELECT a league to find it by code; that function is the only door.
 */
export default function LeagueGate({ memberships, onPick, onChanged, toast, email }) {
  const [mode, setMode] = useState(memberships.length ? 'list' : 'create')
  const [busy, setBusy] = useState(false)

  const [name, setName] = useState('')
  const [teamName, setTeamName] = useState('')
  const [espnLeagueId, setEspnLeagueId] = useState('')
  const [season, setSeason] = useState(SEASONS[0])

  const [code, setCode] = useState('')
  const [joinTeamName, setJoinTeamName] = useState('')

  async function createLeague(e) {
    e.preventDefault()
    if (!name.trim()) return toast.error('Give the league a name.')
    if (!teamName.trim()) return toast.error('Give your team a name.')
    setBusy(true)
    try {
      const { data, error } = await supabase.rpc('create_league', {
        p_name: name.trim(),
        p_team_name: teamName.trim(),
        p_espn_league_id: espnLeagueId.trim() || null,
        p_season: Number(season),
      })
      if (error) throw error
      toast.success(`${name.trim()} created — you're the commissioner.`)
      await onChanged()
      onPick(data)
    } catch (err) {
      toast.error(err.message)
    } finally {
      setBusy(false)
    }
  }

  async function joinLeague(e) {
    e.preventDefault()
    if (!code.trim()) return toast.error('Enter the invite code.')
    if (!joinTeamName.trim()) return toast.error('Give your team a name.')
    setBusy(true)
    try {
      const { data, error } = await supabase.rpc('join_league', {
        p_code: code.trim(),
        p_team_name: joinTeamName.trim(),
      })
      if (error) throw error
      toast.success('Joined.')
      await onChanged()
      onPick(data)
    } catch (err) {
      toast.error(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mx-auto flex min-h-full max-w-lg flex-col justify-center px-4 py-10">
      <div className="mb-6 flex flex-col items-center gap-2 text-center">
        <div className="rounded-2xl bg-emerald-500/10 p-3 ring-1 ring-emerald-500/30">
          <Trophy className="h-7 w-7 text-emerald-400" aria-hidden />
        </div>
        <h1 className="text-2xl font-black tracking-tight text-slate-100">Your leagues</h1>
        <p className="text-sm text-slate-500">Signed in as {email}</p>
      </div>

      {memberships.length > 0 && (
        <Card className="mb-4 divide-y divide-slate-800">
          {memberships.map((m) => (
            <button
              key={m.league_id}
              onClick={() => onPick(m.league_id)}
              className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-slate-800/50"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-bold text-slate-100">{m.leagues.name}</p>
                <p className="truncate text-xs text-slate-500">
                  {m.team_name} · {m.leagues.season}
                </p>
              </div>
              {m.role === 'commissioner' && (
                <Badge className="bg-amber-500/15 text-amber-300 ring-amber-500/30">
                  <ShieldCheck className="h-3 w-3" aria-hidden /> Commissioner
                </Badge>
              )}
              <ArrowRight className="h-4 w-4 shrink-0 text-slate-500" aria-hidden />
            </button>
          ))}
        </Card>
      )}

      <div className="mb-4 flex gap-1 rounded-lg bg-slate-900/60 p-1 ring-1 ring-slate-800">
        {[['create', 'Create a league', Plus], ['join', 'Join with a code', LogIn]].map(
          ([key, label, Icon]) => (
            <button
              key={key}
              onClick={() => setMode(key)}
              className={cx(
                'flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-semibold transition-colors',
                mode === key ? 'bg-slate-800 text-slate-100' : 'text-slate-400 hover:text-slate-200'
              )}
            >
              <Icon className="h-3.5 w-3.5" aria-hidden /> {label}
            </button>
          )
        )}
      </div>

      <Card className="p-5">
        {mode === 'join' ? (
          <form onSubmit={joinLeague} className="space-y-3">
            <Field label="Invite code" hint="Ask your commissioner for this.">
              <Input
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
                placeholder="ABCD2345"
                className="font-mono tracking-widest"
                maxLength={8}
                required
              />
            </Field>
            <Field label="Your team name">
              <Input
                value={joinTeamName}
                onChange={(e) => setJoinTeamName(e.target.value)}
                placeholder="Gridiron Goblins"
                required
              />
            </Field>
            <Button type="submit" variant="primary" busy={busy} className="w-full py-2">
              <Users className="h-4 w-4" /> Join league
            </Button>
          </form>
        ) : (
          <form onSubmit={createLeague} className="space-y-3">
            <Field label="League name">
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="CoolClan"
                required
              />
            </Field>
            <Field label="Your team name">
              <Input
                value={teamName}
                onChange={(e) => setTeamName(e.target.value)}
                placeholder="Gridiron Goblins"
                required
              />
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field
                label="ESPN league id"
                hint="Optional now — you can add it later."
              >
                <Input
                  value={espnLeagueId}
                  onChange={(e) => setEspnLeagueId(e.target.value.replace(/\D/g, ''))}
                  placeholder="123456"
                  inputMode="numeric"
                />
              </Field>
              <Field label="Season">
                <Select value={season} onChange={(e) => setSeason(e.target.value)}>
                  {SEASONS.map((s) => <option key={s} value={s}>{s}</option>)}
                </Select>
              </Field>
            </div>
            <p className="rounded-lg bg-slate-950/60 px-3 py-2 text-xs text-slate-500 ring-1 ring-slate-800">
              You become the commissioner. After this you can connect ESPN and invite
              your managers from League Settings.
            </p>
            <Button type="submit" variant="primary" busy={busy} className="w-full py-2">
              <Plus className="h-4 w-4" /> Create league
            </Button>
          </form>
        )}
      </Card>

      <button
        onClick={() => supabase.auth.signOut()}
        className="mx-auto mt-5 flex items-center gap-1.5 text-xs text-slate-500 transition-colors hover:text-slate-300"
      >
        <LogOut className="h-3 w-3" aria-hidden /> Sign out
      </button>
    </div>
  )
}
