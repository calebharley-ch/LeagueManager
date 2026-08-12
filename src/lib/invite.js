const KEY = 'lm_pending_invite'

/**
 * Capture an `?invite=<token>` from the URL and remember it.
 *
 * ⚠️ IT HAS TO SURVIVE A ROUND TRIP. The recipient clicks the link, registers,
 * gets a confirmation email, comes back through a DIFFERENT url, and only then
 * has a session. Holding the token in React state would lose it at the first
 * navigation, so it goes to localStorage and is cleared only once redeemed.
 *
 * ⚠️ REMOVES ONLY THE `invite` PARAM. Clearing the whole query string would
 * also eat `?code=`, which is how the PKCE OAuth flow returns its session —
 * sign-in would then silently fail with nothing in the console.
 */
export function captureInviteFromUrl() {
  try {
    const url = new URL(window.location.href)
    const token = url.searchParams.get('invite')
    if (!token) return getPendingInvite()

    localStorage.setItem(KEY, token)

    url.searchParams.delete('invite')
    const qs = url.searchParams.toString()
    window.history.replaceState(
      {}, '',
      url.pathname + (qs ? `?${qs}` : '') + url.hash
    )
    return token
  } catch {
    return null
  }
}

export function getPendingInvite() {
  try { return localStorage.getItem(KEY) } catch { return null }
}

export function clearPendingInvite() {
  try { localStorage.removeItem(KEY) } catch { /* private mode */ }
}
