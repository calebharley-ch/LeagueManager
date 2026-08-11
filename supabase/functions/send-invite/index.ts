/**
 * send-invite — email the invite code to managers who have not registered.
 *
 * Deploy: supabase functions deploy send-invite --project-ref <ref> --use-api
 * Call:   supabase.functions.invoke('send-invite', {
 *           body: { league_id, targets: [{ espn_team_id, email }] }
 *         })
 *
 * ⚠️ COMMISSIONER ONLY. This sends mail to arbitrary addresses carrying the
 * league's invite code. Anyone who could call it could both spam strangers and
 * leak the code, so the role check is the whole security model here.
 *
 * Returns a per-target result so the UI can show which sends worked. One bad
 * address never stops the rest of the batch.
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

// ⚠️ NO HARDCODED FALLBACK — this repo is public. See notify-trade for why.
// supabase secrets set BREVO_SENDER_EMAIL=you@example.com
const SENDER_EMAIL = Deno.env.get('BREVO_SENDER_EMAIL') ?? ''
const SENDER_NAME = Deno.env.get('BREVO_SENDER_NAME') ?? 'League Manager'
const APP_URL = Deno.env.get('APP_URL') ?? ''

// Cap a single batch. A twelve-team league needs twelve; anything far above
// that is a mistake or an attempt to use this as a mail relay.
const MAX_TARGETS = 40

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })

const esc = (s: unknown) =>
  String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')

// Deliberately loose. Real validation is the send failing; this only catches
// obvious typos before we spend a Brevo call on them.
const looksLikeEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
  const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!
  const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const BREVO_KEY = Deno.env.get('BREVO_API_KEY')

  try {
    const body = await req.json().catch(() => ({}))
    const leagueId = body.league_id ?? ''
    const targets = Array.isArray(body.targets) ? body.targets : []
    if (!leagueId) return json({ error: 'league_id is required' }, 400)
    if (targets.length === 0) return json({ error: 'No recipients given' }, 400)
    if (targets.length > MAX_TARGETS) {
      return json({ error: `Too many recipients (max ${MAX_TARGETS})` }, 400)
    }
    if (!BREVO_KEY) return json({ error: 'BREVO_API_KEY is not set on the server' }, 500)
    if (!SENDER_EMAIL) {
      return json({
        error: 'BREVO_SENDER_EMAIL is not set. Run: supabase secrets set ' +
               'BREVO_SENDER_EMAIL=you@example.com',
      }, 500)
    }

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

    const { data: membership } = await serviceClient
      .from('league_members')
      .select('role, team_name')
      .eq('league_id', leagueId)
      .eq('profile_id', user.id)
      .maybeSingle()
    if (!membership) return json({ error: 'You are not a member of this league' }, 403)
    if (membership.role !== 'commissioner') {
      return json({ error: 'Only the commissioner can send invites' }, 403)
    }

    const { data: league } = await serviceClient
      .from('leagues').select('name, invite_code').eq('id', leagueId).single()
    if (!league) return json({ error: 'League not found' }, 404)

    const { data: espnTeams } = await serviceClient
      .from('espn_teams').select('espn_team_id, team_name').eq('league_id', leagueId)

    const nameFor = (id: number) =>
      espnTeams?.find((t) => t.espn_team_id === id)?.team_name ?? `Team ${id}`

    const results: Array<Record<string, unknown>> = []

    for (const t of targets) {
      const espnTeamId = Number(t.espn_team_id)
      const email = String(t.email ?? '').trim()
      const teamName = nameFor(espnTeamId)

      if (!Number.isFinite(espnTeamId) || !looksLikeEmail(email)) {
        results.push({ espn_team_id: t.espn_team_id, ok: false, error: 'Invalid email' })
        continue
      }

      const link = APP_URL
        ? `<p style="margin:20px 0"><a href="${esc(APP_URL)}" style="background:#10b981;color:#04140d;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:700">Join the league</a></p>`
        : ''

      const htmlContent = `
<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:520px;color:#0f172a">
  <p style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#64748b;margin:0 0 4px">${esc(league.name)}</p>
  <h1 style="font-size:20px;margin:0 0 12px">You're invited to League Manager</h1>
  <p style="margin:0 0 12px">
    ${esc(membership.team_name)} set up a place to track trades, keeper rules and
    league history for <strong>${esc(league.name)}</strong>. Your team
    <strong>${esc(teamName)}</strong> is already in there.
  </p>
  <p style="margin:0 0 6px">Create an account and join with this code:</p>
  <p style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:22px;font-weight:700;letter-spacing:.15em;background:#f1f5f9;border:1px solid #cbd5e1;border-radius:8px;padding:12px 16px;display:inline-block;margin:0 0 8px">
    ${esc(league.invite_code)}
  </p>
  ${link}
  <p style="font-size:12px;color:#94a3b8;border-top:1px solid #e2e8f0;padding-top:12px;margin-top:20px">
    Not expecting this? You can ignore it — nothing happens until you sign up.
  </p>
</div>`.trim()

      const textContent = [
        `You're invited to League Manager for ${league.name}.`,
        `${membership.team_name} set it up to track trades, keeper rules and league history.`,
        `Your team ${teamName} is already in there.`,
        ``,
        `Join with this invite code: ${league.invite_code}`,
        APP_URL ? `\n${APP_URL}` : '',
        `\nNot expecting this? Ignore it — nothing happens until you sign up.`,
      ].filter(Boolean).join('\n')

      try {
        const res = await fetch('https://api.brevo.com/v3/smtp/email', {
          method: 'POST',
          headers: {
            'api-key': BREVO_KEY,
            'content-type': 'application/json',
            accept: 'application/json',
          },
          body: JSON.stringify({
            sender: { email: SENDER_EMAIL, name: SENDER_NAME },
            to: [{ email, name: teamName }],
            subject: `Join ${league.name} on League Manager`,
            htmlContent,
            textContent,
          }),
        })

        if (!res.ok) {
          const detail = await res.text().catch(() => '')
          results.push({
            espn_team_id: espnTeamId, ok: false,
            error: `Brevo HTTP ${res.status}`, detail: detail.slice(0, 300),
          })
          continue
        }

        // Record the address and the send. Upsert so re-inviting updates rather
        // than erroring on the primary key.
        const { data: existing } = await serviceClient
          .from('league_invites')
          .select('send_count')
          .eq('league_id', leagueId).eq('espn_team_id', espnTeamId)
          .maybeSingle()

        await serviceClient.from('league_invites').upsert({
          league_id: leagueId,
          espn_team_id: espnTeamId,
          email,
          invited_at: new Date().toISOString(),
          invited_by: user.id,
          send_count: (existing?.send_count ?? 0) + 1,
          updated_at: new Date().toISOString(),
        }, { onConflict: 'league_id,espn_team_id' })

        results.push({ espn_team_id: espnTeamId, ok: true })
      } catch (err) {
        results.push({
          espn_team_id: espnTeamId, ok: false,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    const sent = results.filter((r) => r.ok).length
    return json({ ok: true, sent, failed: results.length - sent, results })
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 500)
  }
})
