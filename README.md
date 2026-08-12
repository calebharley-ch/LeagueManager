# League Manager

Fantasy football league platform — multi-asset trades, rule proposals with
voting, an append-only audit log, and ESPN data pulled in by the commissioner.

React + Vite + Tailwind + Supabase. Deploys to GitHub Pages.

---

## The flow

```
1. Admin registers                → account only, no team name yet
2. Admin creates a league         → becomes commissioner, gets an invite code
3. Admin connects ESPN            → credentials stored write-only
4. Admin hits "Sync now"          → Edge Function pulls players + rosters
5. Admin shares the invite code   → managers register, join, name their team
```

Team name lives on the **membership**, not the account — you can be a different
team in each league you're in.

---

## Setup

```bash
npm install
cp .env.example .env          # fill in from Supabase → Project Settings → API
```

Run `schema.sql` in the Supabase SQL editor. If your database predates a
migration in `migrations/`, run those too, in order — `create table if not
exists` does nothing to a table that already has rows, so `schema.sql` alone
will not add new columns to a live database. Each migration is additive and safe
to run twice.

Then:

```bash
npm run dev
```

Register, create a league — you are its commissioner automatically. No manual
promote step; `create_league()` makes the league and your commissioner
membership in one transaction.

### Deploy the sync function

The ESPN sync runs server-side, so it needs the Supabase CLI once:

```bash
npx supabase login
npx supabase functions deploy sync-espn --project-ref <your-project-ref> --use-api
```

`--project-ref` deliberately replaces `supabase link`. Linking prompts for your
**database** password, which is a different credential from anything else here
and an unnecessary blocker when all you are shipping is one function. Only link
if you later want to run migrations from the CLI.

`--use-api` bundles the function on Supabase's servers. Without it the CLI wants
a local Docker container, so on a machine with no Docker the deploy fails on
something that has nothing to do with your code. Drop the flag if you have
Docker running and would rather build locally.

**On Windows, run `npx.cmd`, not `npx`.** PowerShell's execution policy blocks
the `npx.ps1` shim (`cannot be loaded because running scripts is disabled`); the
`.cmd` shim goes through `cmd.exe` and sidesteps it without changing any
security setting. `login` is interactive — it prints a link, and you paste the
code the browser shows back into the terminal prompt.

Redeploy with the same command after any edit to
`supabase/functions/sync-espn/index.ts` — the function is not hot-reloaded.

`SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are injected
into Edge Functions automatically — you do not configure them anywhere.

Until this is deployed, everything except the ESPN tabs works, and "Sync now"
returns a message telling you to deploy it.

### Google / OAuth login

The sign-in screen already has a "Continue with Google" button. To make it work:

1. **Supabase → Authentication → Providers → Google** → enable, and paste a
   Client ID + Secret from a Google Cloud OAuth 2.0 credential.
2. In Google Cloud, set the **Authorised redirect URI** to the value Supabase
   shows you on that page — it looks like
   `https://<project-ref>.supabase.co/auth/v1/callback`. This is Supabase's
   URL, not yours.
3. **Supabase → Authentication → URL Configuration → Redirect URLs**, add both:
   ```
   http://localhost:5173/
   https://<user>.github.io/LeagueManager/
   ```
   The trailing slash matters. `authRedirectTo()` derives these from Vite's
   `BASE_URL`, so they are exactly what the app sends.

To add more providers, extend `OAUTH_PROVIDERS` in `src/components/Auth.jsx` —
each entry renders a button. The provider must also be enabled in Supabase, or
the click returns "Unsupported provider" (the app appends a hint saying so).

⚠️ **`detectSessionInUrl` must stay `true`** in `src/supabaseClient.js`. OAuth
returns the session in the URL fragment; with that flag off, sign-in completes
at Google, redirects back, and is silently dropped — no error anywhere, because
nothing technically failed.

⚠️ **`handle_new_user` reads several name fields.** Email signup sends
`display_name`; Google sends `full_name` and `name`. The trigger coalesces
through all of them and falls back to the email's local part, so OAuth users
never land with a blank name showing as "Someone" in the audit log.

---

## Commands

```bash
npm run dev       # local dev server on :5173
npm run build     # production bundle into dist/
npm run preview   # serve the built bundle
npm run deploy    # build and publish dist/ to the gh-pages branch
```

---

## How ESPN credentials are handled

The commissioner pastes `espn_s2` and `SWID` into League Settings. From there:

```
browser ──HTTPS──► set_espn_credentials()  ──►  league_espn_credentials
                                                  (no SELECT policy, by anyone)
                                                          │
                                                   sync-espn Edge Function
                                                   (service_role, server-side)
                                                          │
                                                          ▼
                                                        ESPN
```

**Nobody can read those credentials back through the API** — not managers, not
the commissioner, not the person who typed them in. There is deliberately no
`SELECT` policy on that table. Only the Edge Function reads them, using the
service_role key, and it runs on Supabase's servers.

That matters because `ESPN_S2` and `SWID` are session cookies for a *personal
ESPN account*, not scoped tokens — anyone holding them can act as that user on
ESPN. Putting them anywhere the browser could reach means putting them in the
public JS bundle, since Vite inlines every `VITE_` variable and GitHub Pages
serves that bundle to the world. Running the fetch server-side also sidesteps
ESPN's missing CORS headers, which would block a browser request outright.

The UI reads `leagues.espn_connected` — a boolean — to show connection state.
That is exactly enough, and it leaks nothing.

**How long the cookies last is not documented by ESPN**, and an earlier version
of this file claimed "a few weeks" — that was a guess, not a measurement. They
appear to be persistent across sessions. To find out for yours, read the
**Expires** column next to `espn_s2` in DevTools → Application → Cookies on
`fantasy.espn.com`.

What definitely kills them early:

- **signing out of ESPN in that browser** — grab the cookie somewhere you stay
  signed in
- changing your ESPN password
- clearing cookies, or a privacy extension doing it for you

When a sync starts failing with HTTP 401/403, reconnect with fresh values. The
function is built for this: it reports the credential failure specifically, and
the player universe still syncs without cookies, so only rosters go stale.
Public leagues need no cookies at all — just the ESPN league id.

### Measured ESPN API behaviour

**`X-Fantasy-Filter` must be top-level on the `/players` endpoint.** Nesting it
under a `players` key — which is what league-scoped views expect — makes ESPN
silently ignore the entire filter. Season 2025:

| filter shape | payload | rows | first row |
|---|---|---|---|
| `{players:{limit:50,…}}` | 21.60 MB | 2876 | Curtis Hodges (rank 2399) |
| `{limit:50,…}` | 0.90 MB | 50 | Ja'Marr Chase (rank 1) |

That 21.6 MB response is what made the Edge Function return
`WORKER_RESOURCE_LIMIT` (HTTP 546) — `JSON.parse` on it exceeds the worker's
memory/CPU budget. An earlier version of this file claimed the endpoint simply
ignores `limit` and the sort; that was wrong, and wrong for the same reason —
the probe used the nested shape too.

`kona_player_info` includes full stat splits, so it scales badly: 300 rows →
4.95 MB, 600 → 9.17 MB, 1000 → 13.50 MB. `players_wl` is ~64× lighter at the
same row count and honours the same sort, but carries no draft ranks and no
injury status.

So `fetchPlayers()` makes two calls and merges them: 500 detailed rows for the
top of the board, 3000 cheap rows for breadth. Measured end to end at 8.47 MB
fetched, 38 MB peak heap, **1196 unique offensive players, 354 with a real draft
rank**. Roughly 30% of any page is IDP that `POS_MAP` discards.

The merge dedupes by `espn_id` into a `Map`. That is load-bearing, not tidiness:
the two calls overlap almost completely, and Postgres rejects an upsert batch
containing the same conflict key twice.

---

## Trade emails (Brevo)

When a trade is proposed, `notify-trade` emails the receiving manager. Deploy it
the same way as the sync function:

```bash
npx supabase functions deploy notify-trade --project-ref <ref> --use-api
npx supabase secrets set BREVO_API_KEY=xxx --project-ref <ref>
```

Optional secrets: `BREVO_SENDER_EMAIL` (must be a **verified sender** in Brevo),
`BREVO_SENDER_NAME`, and `APP_URL` — set the last one after deploying to Pages
and the email gains a "Review the trade" button.

⚠️ **Do not enable Brevo's "Block unknown IP addresses".** Supabase Edge
Functions have no static egress IP — the Deno Deploy runtime uses a different
address per invocation, so there is nothing to authorise. Brevo also *auto-enables*
blocking if it sees no new IPs for 30 days, so leave the setting explicitly off
rather than trusting the default.

⚠️ **The recipient's address never reaches the browser.** `profiles` has no email
column; addresses live in `auth.users`, readable only by the service role. The
client posts a `trade_id` and gets back `sent` or `skipped` — never the address.

**A failed email must never fail a trade.** `notify-trade` returns 200 with a
reason for every expected miss (team has no account, notifications off, no
address on file, key unset), and the client calls it *after* the trade is
committed, outside the try/catch that rolls a trade back. Only a genuine Brevo
error surfaces, worded so it is obvious the trade itself saved.

Managers opt out per league under Profile — `league_members.email_notifications`,
default true, because a trade nobody noticed is the problem this solves.

### Inviting managers

Profile → League teams lists every ESPN team. Unregistered ones get an email box
and a Send button, plus a "Send N invites" batch button in the header. Addresses
live in `league_invites`, keyed by `(league_id, espn_team_id)`.

Its own table rather than a column on `espn_teams`, deliberately: `espn_teams` is
upserted by every sync, and these are other people's personal addresses, so they
get their own RLS boundary. **That table is commissioner-only including SELECT** —
managers can see who has registered, not the league's address book.

`send-invite` is commissioner-gated for the same reason: it mails arbitrary
addresses carrying the league's invite code. It caps a batch at 40 and returns a
per-recipient result, so one bad address never stops the rest.

A gmail.com sender works but is signed by Brevo's domain, so it will not
DKIM-align to gmail.com; Gmail shows "via brevo" and inbox placement is weaker.
Fine for a twelve-person league. A domain you control is the real fix.

---

## Deploying to GitHub Pages

Set the repo name in `vite.config.js`:

```js
const REPO_NAME = 'LeagueManager'   // must match your GitHub repo exactly
```

A site at `https://<user>.github.io/LeagueManager/` needs `base:
'/LeagueManager/'`. Wrong value = every asset 404s. Custom domain or a
`<user>.github.io` root repo → use `'/'`.

Two ways to publish. **Prefer the workflow.**

**GitHub Actions (recommended).** `.github/workflows/deploy.yml` builds and
publishes on every push to `main`. Set repo → Settings → Pages → Source =
**GitHub Actions**, and add `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`
under Settings → Secrets and variables → Actions (either Secrets or Variables —
the workflow reads both). The live site can then never drift from `main`, and
there is no branch to mis-select.

The workflow fails the build rather than shipping a broken site if those vars
are missing, if the URL has a path appended, or if `dist/index.html` does not
reference `/LeagueManager/assets/`. Vite does not error on missing env vars — it
produces a green build that is a blank white screen — so those checks are the
only thing standing between a typo and a dead site.

**Manual fallback.** `npm run deploy` builds and pushes `dist/` to the
`gh-pages` branch, with Pages Source = `Deploy from a branch` → `gh-pages` →
`/ (root)`. ⚠️ Do not mix the two: once Source is "GitHub Actions", running
`npm run deploy` publishes to a branch nothing reads, and the site silently
stops matching `main`.

Both `VITE_` variables must exist at **build** time — Vite inlines them, so
building without them yields a bundle that is fine locally and broken in
production. Add your Pages URL to Supabase → Authentication → URL Configuration
→ Redirect URLs, or confirmation emails will bounce.

---

## Architecture notes

**A team is not an account.** `league_members` holds people who registered;
`espn_teams` holds the twelve teams that actually exist. `src/lib/teams.js`
merges them into one list, joined on `league_members.espn_team_id`, and every
tab reads that. This is deliberate: building the UI around accounts left the
trade dropdown empty in a twelve-team league with one signup. An unclaimed team
still holds picks, still has FAAB, and can still be traded with — it just shows
an "Invite pending" badge. Managers link themselves to their ESPN team from the
Profile tab, and a team already claimed by someone else is not offered.

Because of that, `trades.receiver_id` is nullable and pairs with
`receiver_espn_team_id`; a check constraint enforces exactly one. The update
policy needed no change — with `receiver_id` null, `null = auth.uid()` is NULL,
which RLS treats as false, so an unclaimed team cannot accept its own trade and
the proposer or commissioner settles it.

**FAAB and pick ownership are derived, not stored.** FAAB is
`league.faab_budget − ESPN's acquisitionBudgetSpent ± FAAB moved by COMPLETED
trades`. Picks start as one per team per round per tradeable year and move on
completed trades, keyed by `(year, round, original owner)` so "their 2027 3rd"
stays distinct from yours. Pending and accepted trades move nothing — money that
could still be vetoed has not moved. Note the double-count risk: if you also
process a trade inside ESPN, ESPN's spend figure will eventually include it too.

**No router.** Six tabs in `useState`. `BrowserRouter` 404s on deep links under
GitHub Pages without an SPA fallback hack, and buys nothing here.

**Create/join go through SECURITY DEFINER functions**, not direct inserts.
`create_league()` writes the league and the commissioner membership in one
transaction — as two client calls, a failure between them strands a league with
no members, invisible even to its creator because every SELECT policy requires
membership. `join_league()` exists because a non-member cannot SELECT a league
to find it by code; that function is the only door through the RLS.

**The rulebook stores rules; it does not run votes.** It is the written record
of what the league already agreed — add, edit, repeal. Rules group by category
and carry an effective season. Any member can add one; only the commissioner can
edit or delete, which is the existing RLS, not a UI convention.

The `rule_status` enum still reads `proposed / passed / rejected` because
renaming a Postgres enum in place is not worth a migration. The UI labels them
**Draft / Adopted / Repealed** — `RULE_STATUS_STYLES` in `lib/constants.js` is
the single place that mapping lives. Repealed rules stay in the book, struck
through behind a toggle, because "why did we stop doing that" is a question a
rulebook should answer. `rule_votes` and its unique constraint are left in the
schema unused rather than dropped.

**Two-step trade insert.** `trades` then `trade_items` are separate calls. If
the second fails, `submitTrade` deletes the header it just created — an empty
trade in the feed is worse than no trade. To make it atomic, move it into a
Postgres function and call it with `supabase.rpc()`.

**Audit log** is written client-side via `src/lib/audit.js`. If your database
also writes `audit_log` from triggers, set `AUDIT_FROM_CLIENT = false` — running
both double-logs everything.

**`espn_player_id` on `trade_items` is nullable on purpose.** You must still be
able to trade a player ESPN has never heard of. `player_name` stays the display
truth; the id is only a join key when it exists.

---

## Files

```
schema.sql                          tables, RLS, RPCs, triggers
supabase/functions/sync-espn/       Edge Function — the only reader of credentials
src/
  App.jsx                           session, league switcher, tabs, badges, toasts
  supabaseClient.js
  lib/
    constants.js                    enums, asset styling, formatters
    audit.js                        audit_log writer + AUDIT_FROM_CLIENT switch
    usePlayers.js                   per-league ESPN player cache + search
  components/
    Auth.jsx                        sign in / register
    LeagueGate.jsx                  create a league / join by code / pick one
    LeagueSettings.jsx              ESPN connect, Sync now, invite code, members
    TradeTracker.jsx                multi-asset builder + trade feed
    Rulebook.jsx                    proposals, voting, passed-rule archive
    Rosters.jsx                     synced ESPN rosters
    AuditLog.jsx                    activity feed
    Profile.jsx                     team name + league members
    PlayerPicker.jsx                typeahead with free-text fallback
    ui.jsx                          Button, Card, Badge, Modal, Field, …
```
