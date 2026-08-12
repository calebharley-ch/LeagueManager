import { useState } from 'react'
import { Trophy, Mail, Lock, User } from 'lucide-react'
import { supabase, authRedirectTo } from '../supabaseClient'
import { useEnabledProviders } from '../lib/authProviders'
import { Button, Card, Field, Input } from './ui'

// Providers to offer. Comment one out and its button disappears — but the
// provider ALSO has to be enabled in Supabase → Authentication → Providers, or
// the click returns "Unsupported provider".
const OAUTH_PROVIDERS = [
  {
    id: 'google',
    label: 'Continue with Google',
    // Inline SVG rather than a CDN logo: the strict CSP on a static host blocks
    // external images, and this never 404s.
    icon: (
      <svg className="h-4 w-4" viewBox="0 0 24 24" aria-hidden>
        <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.76h3.57c2.08-1.92 3.28-4.74 3.28-8.09Z" />
        <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.76c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23Z" />
        <path fill="#FBBC05" d="M5.84 14.11a6.6 6.6 0 0 1 0-4.22V7.05H2.18a11 11 0 0 0 0 9.9l3.66-2.84Z" />
        <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1a11 11 0 0 0-9.82 6.05l3.66 2.84c.87-2.6 3.3-4.51 6.16-4.51Z" />
      </svg>
    ),
  },
]

/**
 * Sign in / register.
 *
 * ⚠️ NO TEAM NAME HERE. Team name belongs to a league MEMBERSHIP, not an
 * account — you can be a different team in each league you join. It is asked
 * for at the point it becomes real: creating or joining a league.
 *
 * display_name is passed as signUp metadata; the handle_new_user trigger reads
 * it to create the profile row. We deliberately do NOT insert into profiles
 * from here — with email confirmation on there is no session yet at signUp, so
 * the insert would fail RLS and leave an auth user with no profile.
 */
export default function Auth({ onError, invite, inviteToken }) {
  // Only offer providers the project actually has on. A disabled one redirects
  // the browser to a JSON error page that no catch block here can intercept.
  const { providers: enabled, loading: providersLoading } = useEnabledProviders()
  const oauthProviders = OAUTH_PROVIDERS.filter(
    (p) => enabled === null || enabled.includes(p.id)
  )

  // An invited person almost certainly has no account yet.
  const [mode, setMode] = useState(invite ? 'signup' : 'signin')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [busy, setBusy] = useState(false)
  const [oauthBusy, setOauthBusy] = useState(null)
  const [notice, setNotice] = useState('')

  const isSignUp = mode === 'signup'

  async function signInWithProvider(providerId) {
    setNotice('')
    setOauthBusy(providerId)
    try {
      const { error } = await supabase.auth.signInWithOAuth({
        provider: providerId,
        // Must match a Redirect URL configured in Supabase exactly. Derived
        // from Vite's BASE_URL so it is correct in dev AND under the GitHub
        // Pages subpath — see authRedirectTo().
        options: { redirectTo: authRedirectTo() },
      })
      if (error) throw error
      // On success the browser navigates away, so nothing after this runs.
    } catch (err) {
      const hint = /provider is not enabled|Unsupported provider/i.test(err.message)
        ? ` — enable it in Supabase → Authentication → Providers.`
        : ''
      onError?.(err.message + hint)
      setOauthBusy(null)
    }
  }

  async function handleSubmit(e) {
    e.preventDefault()
    setNotice('')
    setBusy(true)
    try {
      if (isSignUp) {
        const { data, error } = await supabase.auth.signUp({
          email: email.trim(),
          password,
          options: {
            data: { display_name: displayName.trim() || null },
            // ⚠️ CARRY THE INVITE THROUGH THE CONFIRMATION EMAIL.
            // The token normally rides in localStorage, which breaks if they
            // click the invite on a laptop and open the confirmation email on
            // a phone — different storage, so they would land signed in with no
            // league. Putting it in the return URL makes the flow survive that.
            //
            // Requires `.../LeagueManager/**` in Supabase's Redirect URLs; a
            // bare URL entry will not match one carrying a query string, and
            // Supabase silently falls back to the Site URL. That fallback is
            // harmless — the localStorage path still works same-browser.
            emailRedirectTo: inviteToken
              ? `${authRedirectTo()}?invite=${encodeURIComponent(inviteToken)}`
              : authRedirectTo(),
          },
        })
        if (error) throw error
        // With email confirmation enabled Supabase returns a user but no
        // session. Say so, instead of leaving a blank screen.
        if (!data.session) {
          setNotice(
            invite
              ? `Check your email to confirm your account. The link brings you back here and joins you as ${invite.team_name}.`
              : 'Check your email to confirm your account, then sign in.'
          )
          setMode('signin')
        }
      } else {
        const { error } = await supabase.auth.signInWithPassword({
          email: email.trim(),
          password,
        })
        if (error) throw error
      }
    } catch (err) {
      onError?.(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-full items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center gap-2 text-center">
          <div className="rounded-2xl bg-emerald-500/10 p-3 ring-1 ring-emerald-500/30">
            <Trophy className="h-7 w-7 text-emerald-400" aria-hidden />
          </div>
          <h1 className="text-2xl font-black tracking-tight text-slate-100">League Manager</h1>
          <p className="text-sm text-slate-500">Trades, rules and the receipts for both.</p>
        </div>

        {/* Arrived from an invite link. Say what they are joining BEFORE asking
            for a password — "create an account" with no context is where people
            bounce. The team is already chosen for them. */}
        {invite && (
          <div className="mb-4 rounded-xl bg-emerald-500/10 px-4 py-3 text-sm ring-1 ring-emerald-500/30">
            <p className="font-semibold text-emerald-300">
              You're invited to {invite.league_name}
            </p>
            <p className="mt-0.5 text-emerald-200/70">
              Create an account and you'll join as <strong>{invite.team_name}</strong> —
              no invite code needed.
            </p>
          </div>
        )}

        <Card className="p-5">
          <div className="mb-4 flex rounded-lg bg-slate-950/60 p-1 ring-1 ring-slate-800">
            {[['signin', 'Sign in'], ['signup', 'Register']].map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => { setMode(key); setNotice('') }}
                className={
                  'flex-1 rounded-md px-3 py-1.5 text-sm font-semibold transition-colors ' +
                  (mode === key ? 'bg-slate-800 text-slate-100' : 'text-slate-400 hover:text-slate-200')
                }
              >
                {label}
              </button>
            ))}
          </div>

          {notice && (
            <p className="mb-4 rounded-lg bg-emerald-500/10 px-3 py-2 text-sm text-emerald-300 ring-1 ring-emerald-500/30">
              {notice}
            </p>
          )}

          {!providersLoading && oauthProviders.length > 0 && (
            <>
              <div className="space-y-2">
                {oauthProviders.map((p) => (
                  <Button
                    key={p.id}
                    type="button"
                    variant="neutral"
                    busy={oauthBusy === p.id}
                    onClick={() => signInWithProvider(p.id)}
                    className="w-full py-2"
                  >
                    {oauthBusy !== p.id && p.icon}
                    {p.label}
                  </Button>
                ))}
              </div>
              <div className="my-4 flex items-center gap-3">
                <span className="h-px flex-1 bg-slate-800" />
                <span className="text-xs font-semibold uppercase tracking-wide text-slate-600">or</span>
                <span className="h-px flex-1 bg-slate-800" />
              </div>
            </>
          )}

          <form onSubmit={handleSubmit} className="space-y-3">
            {isSignUp && (
              <Field label="Your name" hint="Optional.">
                <div className="relative">
                  <User className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" aria-hidden />
                  <Input
                    className="pl-9"
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    placeholder="Caleb"
                  />
                </div>
              </Field>
            )}

            <Field label="Email">
              <div className="relative">
                <Mail className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" aria-hidden />
                <Input
                  className="pl-9"
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  required
                />
              </div>
            </Field>

            <Field label="Password" hint={isSignUp ? 'At least 6 characters.' : undefined}>
              <div className="relative">
                <Lock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" aria-hidden />
                <Input
                  className="pl-9"
                  type="password"
                  autoComplete={isSignUp ? 'new-password' : 'current-password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  minLength={6}
                  required
                />
              </div>
            </Field>

            <Button type="submit" variant="primary" busy={busy} className="w-full py-2">
              {isSignUp ? 'Create account' : 'Sign in'}
            </Button>
          </form>
        </Card>

        <p className="mt-4 text-center text-xs text-slate-600">
          Next you'll create a league or join one with an invite code.
        </p>
      </div>
    </div>
  )
}
