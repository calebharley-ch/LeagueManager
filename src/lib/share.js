/**
 * Links you can paste into the league group chat.
 *
 * The league lives in WhatsApp; this app is where the work actually gets done.
 * Nothing here changes that — it just makes the trip from one to the other a
 * single tap, so "go vote on the trade" stops being a sentence somebody has to
 * type and then explain.
 *
 * Two halves:
 *   - building a link that lands on the right tab (and the right card), and
 *   - reading that link back on arrival.
 */
import { authRedirectTo } from '../supabaseClient'

/** Tab keys a link is allowed to open. Anything else is ignored rather than
 *  trusted — the value comes off the URL bar. */
export const LINKABLE_TABS = [
  'trades', 'rules', 'rosters', 'history', 'audit', 'settings', 'profile',
]

/**
 * A link back into this app.
 *
 * Built from authRedirectTo() rather than window.location so it is right under
 * the GitHub Pages subpath — and so it never carries whatever query string the
 * sharer happens to be sitting on.
 */
export function appLink({ tab, focus } = {}) {
  const url = new URL(authRedirectTo())
  if (tab) url.searchParams.set('tab', tab)
  if (focus) url.searchParams.set('focus', focus)
  return url.toString()
}

/** One-click join, bound to a team. Same shape the invite email sends. */
export function inviteLink(token) {
  const url = new URL(authRedirectTo())
  url.searchParams.set('invite', token)
  return url.toString()
}

/**
 * Read `?tab=` / `?focus=` and clear them.
 *
 * ⚠️ DELETES ONLY ITS OWN PARAMS, for the same reason captureInviteFromUrl
 * does: `?code=` is how the PKCE OAuth flow returns a session, and wiping the
 * query string would break sign-in with nothing in the console.
 */
export function captureDeepLink() {
  try {
    const url = new URL(window.location.href)
    const tab = url.searchParams.get('tab')
    const focus = url.searchParams.get('focus')
    if (!tab && !focus) return {}

    url.searchParams.delete('tab')
    url.searchParams.delete('focus')
    const qs = url.searchParams.toString()
    window.history.replaceState({}, '', url.pathname + (qs ? `?${qs}` : '') + url.hash)

    return {
      tab: LINKABLE_TABS.includes(tab) ? tab : undefined,
      focus: focus || undefined,
    }
  } catch {
    return {}
  }
}

/* ── Messages ──────────────────────────────────────────────────────────────
   Written to be read on a phone, in a thread that is mostly insults. Short,
   no markdown (WhatsApp would render the asterisks), and the ask comes first
   so it survives being truncated in a notification. */

export const SHARE_TEXT = {
  tradeVote: ({ proposer, receiver, approvals, needApprove }) =>
    `Trade up for a league vote: ${proposer} and ${receiver}. ` +
    `${approvals} of ${needApprove} approvals so far — needs ${needApprove - approvals} more.`,

  tradePending: ({ proposer, receiver }) =>
    `${proposer} offered ${receiver} a trade. Accept or reject it here:`,

  tradeEspn: ({ proposer, receiver, work }) =>
    `Trade between ${proposer} and ${receiver} passed the league vote. ` +
    `Still needs the ${work} moved over in ESPN.`,

  proposal: ({ title, author }) =>
    `${author} put up a rule idea for next season: "${title}". Have a look:`,

  rule: ({ title, league }) =>
    `${league} rulebook — "${title}":`,

  invite: ({ team, league }) =>
    `You're ${team} in ${league}. This link signs you straight in, no code needed:`,

  joinCode: ({ league, code }) =>
    `Join ${league} — open this and use the code ${code}:`,

  app: ({ league }) => `${league} — trades, rules and the receipts for both:`,
}

/* ── Sending ─────────────────────────────────────────────────────────────── */

/** True where the OS share sheet exists — phones, basically. Read once: it
 *  cannot change for the life of the page. */
export const canNativeShare =
  typeof navigator !== 'undefined' && typeof navigator.share === 'function'

/**
 * Hand `text` + `url` to whatever this device shares with.
 *
 * On a phone that is the native sheet, WhatsApp included, which is the whole
 * point. On a desktop it is the clipboard, ready to paste into WhatsApp Web.
 *
 * ⚠️ MUST BE CALLED STRAIGHT FROM THE CLICK. Both navigator.share and the
 * clipboard need a live user gesture; awaiting anything first spends it and
 * the call fails with a permission error that reads like a bug.
 *
 * Returns 'shared' | 'copied' | 'cancelled' | 'failed'.
 */
export async function shareLink({ text, url, toast, copied = 'Link copied — paste it in the chat.' }) {
  const payload = text ? `${text}\n${url}` : url

  if (canNativeShare) {
    try {
      // Everything in `text`: some targets take `url` and drop `text`, and a
      // bare link with no ask is exactly what this is trying to avoid.
      await navigator.share({ text: payload })
      return 'shared'
    } catch (err) {
      // Dismissing the sheet is not a failure — do not then paste to their
      // clipboard behind their back.
      if (err?.name === 'AbortError') return 'cancelled'
      // Anything else (no permission, unsupported target): fall through.
    }
  }

  try {
    await navigator.clipboard.writeText(payload)
    toast?.success(copied)
    return 'copied'
  } catch {
    // Clipboard needs a secure context and permission. Show the link so it can
    // be selected by hand rather than leaving a dead button.
    toast?.error(`Copy failed — the link is ${url}`)
    return 'failed'
  }
}
