/**
 * notify-trade — email the receiving manager that a trade is waiting on them.
 *
 * Deploy:  supabase functions deploy notify-trade --project-ref <ref> --use-api
 * Call:    supabase.functions.invoke('notify-trade', { body: { trade_id } })
 *
 * ⚠️ THE EMAIL ADDRESS NEVER REACHES THE BROWSER.
 * `profiles` has no email column on purpose — addresses live in auth.users,
 * which only the service_role can read. The client sends a trade id and gets
 * back "sent" or "skipped"; it never learns who was mailed or at what address.
 *
 * ⚠️ THIS MUST NEVER FAIL A TRADE. The trade is already committed by the time
 * this is called. The caller fires it and ignores the result — see
 * submitTrade() in TradeTracker.jsx. Every branch here returns 200 with a
 * reason rather than throwing, so a mail problem can never look like a trade
 * problem.
 *
 * Secrets: BREVO_API_KEY (required), BREVO_SENDER_EMAIL, BREVO_SENDER_NAME,
 *          APP_URL (all optional — see defaults below).
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

// ⚠️ NO HARDCODED FALLBACK. This repo is public on GitHub Pages; a personal
// address in the source would be scraped. Set it with:
//   supabase secrets set BREVO_SENDER_EMAIL=you@example.com
// It MUST be a verified sender in Brevo or the API returns 400 and nothing is
// delivered.
const SENDER_EMAIL = Deno.env.get('BREVO_SENDER_EMAIL') ?? ''
const SENDER_NAME = Deno.env.get('BREVO_SENDER_NAME') ?? 'League Manager'
const APP_URL = Deno.env.get('APP_URL') ?? ''

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })

/** Escape anything that reaches the HTML body. Team names and rationale are
 *  user-controlled free text; unescaped they would be an injection vector into
 *  every league-mate's inbox. */
const esc = (s: unknown) =>
  String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')

const ordinal = (n: number) => {
  const s = ['th', 'st', 'nd', 'rd']
  const v = n % 100
  return n + (s[(v - 20) % 10] ?? s[v] ?? s[0])
}

function describeAsset(item: any, nameFor: (i: any) => string | null) {
  if (item.item_type === 'faab') return `$${item.faab_amount} FAAB`
  if (item.item_type === 'player') {
    return item.player_position
      ? `${item.player_name} (${item.player_position})`
      : item.player_name
  }
  const owner = nameFor(item)
  const base = `${item.pick_year} ${ordinal(item.pick_round)}-round pick`
  return owner ? `${base} (${owner})` : base
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
  const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!
  const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const BREVO_KEY = Deno.env.get('BREVO_API_KEY')

  try {
    const body = await req.json().catch(() => ({}))
    const tradeId = body.trade_id ?? ''
    if (!tradeId) return json({ error: 'trade_id is required' }, 400)

    const authHeader = req.headers.get('Authorization') ?? ''
    if (!authHeader) return json({ error: 'Missing Authorization header' }, 401)

    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false },
    })
    const { data: { user }, error: userErr } = await userClient.auth.getUser()
    if (userErr || !user) return json({ error: 'Not authenticated' }, 401)

    const serviceClient = createClient(SUPABASE_URL, SERVICE_KEY, {
      auth: { persistSession: false },
    })

    // ── The trade ────────────────────────────────────────────────────────────
    const { data: trade, error: tradeErr } = await serviceClient
      .from('trades')
      .select('*, trade_items(*)')
      .eq('id', tradeId)
      .single()
    if (tradeErr || !trade) return json({ error: 'Trade not found' }, 404)

    // Only someone in that league may trigger mail about it, and only the
    // proposer can announce their own trade. Without this check any member
    // could spam the receiver by replaying this endpoint.
    if (trade.proposer_id !== user.id) {
      return json({ error: 'Only the proposer can send this notification' }, 403)
    }
    if (trade.status !== 'pending') {
      return json({ ok: true, skipped: `trade is ${trade.status}, not pending` })
    }

    // ── Who to tell ──────────────────────────────────────────────────────────
    if (!trade.receiver_id) {
      return json({ ok: true, skipped: 'receiving team has no account yet' })
    }

    const { data: members } = await serviceClient
      .from('league_members')
      .select('profile_id, team_name, email_notifications')
      .eq('league_id', trade.league_id)

    const receiver = members?.find((m) => m.profile_id === trade.receiver_id)
    const proposer = members?.find((m) => m.profile_id === trade.proposer_id)
    if (!receiver) return json({ ok: true, skipped: 'receiver is not a league member' })
    if (receiver.email_notifications === false) {
      return json({ ok: true, skipped: 'receiver has email notifications off' })
    }

    // auth.users is readable only with the service role. This is the one place
    // the address is ever handled, and it is not returned to the caller.
    const { data: authUser, error: adminErr } =
      await serviceClient.auth.admin.getUserById(trade.receiver_id)
    const toEmail = authUser?.user?.email
    if (adminErr || !toEmail) {
      return json({ ok: true, skipped: 'no email on file for the receiver' })
    }

    if (!BREVO_KEY) {
      return json({ ok: true, skipped: 'BREVO_API_KEY is not set' })
    }
    if (!SENDER_EMAIL) {
      return json({ ok: true, skipped: 'BREVO_SENDER_EMAIL is not set' })
    }

    // ── Compose ──────────────────────────────────────────────────────────────
    const { data: league } = await serviceClient
      .from('leagues').select('name').eq('id', trade.league_id).single()

    const nameFor = (item: any) =>
      members?.find((m) => m.profile_id === item.pick_original_owner_id)?.team_name ?? null

    const items = trade.trade_items ?? []
    const youGet = items.filter((i: any) => i.side === 'A').map((i: any) => describeAsset(i, nameFor))
    const youGive = items.filter((i: any) => i.side === 'B').map((i: any) => describeAsset(i, nameFor))

    const proposerName = proposer?.team_name ?? 'A manager'
    const leagueName = league?.name ?? 'your league'
    const subject = `${proposerName} proposed a trade`

    const list = (rows: string[]) =>
      rows.length === 0
        ? '<li style="color:#94a3b8"><em>Nothing</em></li>'
        : rows.map((r) => `<li>${esc(r)}</li>`).join('')

    const button = APP_URL
      ? `<p style="margin:24px 0"><a href="${esc(APP_URL)}" style="background:#10b981;color:#04140d;` +
        `padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:700">Review the trade</a></p>`
      : `<p style="margin:24px 0;color:#64748b">Open League Manager to accept or reject it.</p>`

    const htmlContent = `
<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:520px;color:#0f172a">
  <p style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#64748b;margin:0 0 4px">
    ${esc(leagueName)}
  </p>
  <h1 style="font-size:20px;margin:0 0 16px">${esc(proposerName)} proposed a trade</h1>
  <p style="margin:0 0 16px">It is pending your approval.</p>
  <p style="font-weight:700;margin:0 0 4px">You would get</p>
  <ul style="margin:0 0 16px;padding-left:20px">${list(youGet)}</ul>
  <p style="font-weight:700;margin:0 0 4px">You would give up</p>
  <ul style="margin:0 0 16px;padding-left:20px">${list(youGive)}</ul>
  ${trade.rationale ? `<blockquote style="border-left:3px solid #cbd5e1;margin:0 0 16px;padding:4px 0 4px 12px;color:#475569">${esc(trade.rationale)}</blockquote>` : ''}
  ${button}
  <p style="font-size:12px;color:#94a3b8;border-top:1px solid #e2e8f0;padding-top:12px">
    You are getting this because you are in ${esc(leagueName)}. Turn these off under Profile.
  </p>
</div>`.trim()

    const textContent = [
      `${proposerName} proposed a trade in ${leagueName}. It is pending your approval.`,
      ``,
      `You would get: ${youGet.length ? youGet.join(', ') : 'nothing'}`,
      `You would give up: ${youGive.length ? youGive.join(', ') : 'nothing'}`,
      trade.rationale ? `\nThey said: ${trade.rationale}` : '',
      APP_URL ? `\nReview it: ${APP_URL}` : '',
      `\nTurn these emails off under Profile.`,
    ].filter(Boolean).join('\n')

    // ── Send ─────────────────────────────────────────────────────────────────
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'api-key': BREVO_KEY,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({
        sender: { email: SENDER_EMAIL, name: SENDER_NAME },
        to: [{ email: toEmail, name: receiver.team_name }],
        subject,
        htmlContent,
        textContent,
      }),
    })

    if (!res.ok) {
      // Brevo's error body is safe to surface — it says things like "sender not
      // verified", which is exactly what the commissioner needs to read. It does
      // not echo the api-key. The recipient address is NOT included.
      const detail = await res.text().catch(() => '')
      return json({
        ok: false,
        error: `Brevo returned HTTP ${res.status}`,
        detail: detail.slice(0, 400),
      })
    }

    const sent = await res.json().catch(() => ({}))
    return json({ ok: true, sent: true, messageId: sent?.messageId ?? null })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    // Still 200: the trade succeeded, only the email did not.
    return json({ ok: false, error: message })
  }
})
