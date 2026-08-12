import { useState } from 'react'
import { KeyRound, Lock } from 'lucide-react'
import { supabase } from '../supabaseClient'
import { Button, Card, Field, Input } from './ui'

/**
 * Shown after a recovery link signs you in.
 *
 * ⚠️ THIS SCREEN IS THE WHOLE POINT OF THE RESET. The recovery link already
 * created a session, so without stopping here the user lands in the app still
 * not knowing their password — and next time they are locked out again with no
 * idea why the reset "didn't work".
 */
export default function SetPassword({ email, onDone, onCancel, toast }) {
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)

  async function save(e) {
    e.preventDefault()
    if (password.length < 6) return toast.error('Password must be at least 6 characters.')
    if (password !== confirm) return toast.error('Those two passwords do not match.')
    setBusy(true)
    try {
      const { error } = await supabase.auth.updateUser({ password })
      if (error) throw error
      toast.success('Password updated. You are signed in.')
      onDone()
    } catch (err) {
      toast.error(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-full items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center gap-2 text-center">
          <div className="rounded-2xl bg-emerald-500/10 p-3 ring-1 ring-emerald-500/30">
            <KeyRound className="h-7 w-7 text-emerald-400" aria-hidden />
          </div>
          <h1 className="text-2xl font-black tracking-tight text-slate-100">Set a new password</h1>
          <p className="text-sm text-slate-500">
            {email ? `For ${email}.` : 'Choose something you will remember.'}
          </p>
        </div>

        <Card className="p-5">
          <form onSubmit={save} className="space-y-3">
            <Field label="New password" hint="At least 6 characters.">
              <div className="relative">
                <Lock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" aria-hidden />
                <Input
                  className="pl-9"
                  type="password"
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  minLength={6}
                  required
                  autoFocus
                />
              </div>
            </Field>
            <Field label="Confirm password">
              <div className="relative">
                <Lock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" aria-hidden />
                <Input
                  className="pl-9"
                  type="password"
                  autoComplete="new-password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  minLength={6}
                  required
                />
              </div>
            </Field>
            <Button type="submit" variant="primary" busy={busy} className="w-full py-2">
              Save password
            </Button>
          </form>
        </Card>

        <button
          type="button"
          onClick={onCancel}
          className="mt-4 w-full text-center text-xs text-slate-600 hover:text-slate-400"
        >
          Skip for now
        </button>
      </div>
    </div>
  )
}
