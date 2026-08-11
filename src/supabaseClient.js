import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

// Fail loudly at boot rather than with a confusing "Failed to fetch" on the
// first query. Vite inlines these at BUILD time, so a missing var in your
// GitHub Actions environment produces a bundle that is broken in production
// but fine locally — this message is what tells you that.
if (!url || !anonKey) {
  throw new Error(
    'Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY.\n' +
    'Local: copy .env.example to .env and fill it in, then restart `npm run dev`.\n' +
    'GitHub Pages: these must be set in the build environment before `npm run build`.'
  )
}

export const supabase = createClient(url, anonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    // ⚠️ MUST STAY TRUE FOR GOOGLE / OAUTH LOGIN.
    // The provider redirects back with the session in the URL fragment. With
    // this off the client never parses it, so the user completes sign-in at
    // Google, gets bounced back, and lands on the login screen again — with no
    // error anywhere, because nothing actually failed. It just gets dropped.
    detectSessionInUrl: true,
    flowType: 'pkce',
  },
})

/**
 * Where an OAuth provider should send the user back to.
 *
 * BASE_URL is what Vite substitutes for the `base` in vite.config.js — '/' in
 * dev, '/LeagueManager/' in a production build. Hardcoding origin alone would
 * redirect to the GitHub Pages ROOT, which is a different site (or a 404), so
 * derive it instead of guessing.
 *
 * Whatever this evaluates to must ALSO be listed in
 * Supabase → Authentication → URL Configuration → Redirect URLs, or the
 * provider refuses the callback.
 */
export function authRedirectTo() {
  return `${window.location.origin}${import.meta.env.BASE_URL}`
}
