import { useEffect, useState } from 'react'

/**
 * Which OAuth providers this Supabase project actually has enabled.
 *
 * ⚠️ WHY THIS EXISTS. supabase-js `signInWithOAuth` does not return an error
 * for a disabled provider — it REDIRECTS the browser to Supabase, which
 * responds with raw JSON:
 *
 *   {"code":400,"error_code":"validation_failed",
 *    "msg":"Unsupported provider: provider is not enabled"}
 *
 * The user lands on a white page of JSON on a supabase.co URL and has to press
 * Back. No catch block in this app can intercept that, because the navigation
 * has already happened. The only fix is to not offer the button.
 *
 * `/auth/v1/settings` is a public endpoint (anon key only) that reports the
 * enabled providers, so the UI stays correct on its own: enable Google in the
 * dashboard and the button appears on next load, with no redeploy.
 *
 * Fails OPEN on a network error — showing a button that might not work beats
 * hiding every sign-in option because one fetch timed out.
 */
export function useEnabledProviders() {
  const [state, setState] = useState({ providers: null, loading: true })

  useEffect(() => {
    let alive = true
    const url = import.meta.env.VITE_SUPABASE_URL
    const key = import.meta.env.VITE_SUPABASE_ANON_KEY

    fetch(`${url}/auth/v1/settings`, { headers: { apikey: key } })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((s) => {
        if (!alive) return
        const enabled = Object.entries(s?.external ?? {})
          .filter(([, on]) => on === true)
          .map(([name]) => name)
        setState({ providers: enabled, loading: false })
      })
      .catch(() => alive && setState({ providers: null, loading: false }))

    return () => { alive = false }
  }, [])

  return state
}
