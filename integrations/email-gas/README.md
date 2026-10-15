# Email automation — setup (all free)

AI-drafted emails + HubSpot logging + Gmail sending. Draft-first by default:
AI writes, you review in Gmail, one tap sends.

## 1. Google side (10 min)

1. Go to https://script.google.com → **New project** → paste `Code.gs`.
2. Script Settings → add Script Properties:
   | Key | Where to get it |
   |---|---|
   | `TOKEN` | invent a long random string (this is the shared secret) |
| `OWNER_EMAIL` | Where every new lead is emailed with full details (e.g. `parag@kudtarkar.life`). Set this to receive instant notifications. |
| `AUTO_SEND` | `true` = emails go out immediately; blank/`false` = saved as Gmail drafts for your review. |
| `LLM_API_KEY` | Optional. One key, provider auto-detected from the prefix: `gsk_…` = Groq Cloud, `xai-…` = xAI Grok, `AIza…` = Gemini. Used for the AI-drafted reply emails. |
| `LLM_MODEL` | Optional. Override the draft model (defaults: Groq `llama-3.3-70b-versatile`, xAI `grok-4-fast`, Gemini `gemini-2.0-flash`). |
| `GROK_KEY` / `GEMINI_KEY` | Legacy alternatives, still honoured. Without any key, enquirers still get a fixed confirmation email and you still get the owner notification. |
| `HUBSPOT_CLIENT_ID` / `HUBSPOT_CLIENT_SECRET` / `HUBSPOT_REDIRECT_URI` | **Modern (recommended) CRM auth** — create your app on the new developer platform (developer.hubspot.com → Create app), add the four CRM scopes (`crm.objects.contacts` read+write, `crm.objects.companies` read+write), and set the redirect URL to `https://script.google.com` (Auth tab). Copy the app's Client ID + Client Secret here, plus `HUBSPOT_REDIRECT_URI` = `https://script.google.com`. Then the one-time grant: run `oauthAuthorizeUrl()` in the editor → open the printed URL → approve → copy the `?code=` from the redirect address bar → paste as script property `HUBSPOT_AUTH_CODE` → run `oauthExchange()` once. A long-lived `HUBSPOT_REFRESH_TOKEN` is stored and `hsToken()` keeps access tokens fresh automatically. |
| `HUBSPOT_PRIVATE_TOKEN` | Legacy alternative — a static `pat-…` token from CRM Settings → Integrations → Private Apps (via "Go to Legacy Apps"). Same enrichment features; if both are set, OAuth wins. |
| `SENDER_NAME` | e.g. `Parag — AI Pilot to Production` |
| `BUSINESS_ADDRESS` | Optional. Your trading address shown in the email footer (CAN-SPAM/CAN-SPAM-equivalent best practice for outreach). |
| `LOGO_URL` | Optional. Overrides the branded-email logo (defaults to `https://kudtarkar.life/assets/wordmark-email.png`). |
| `PORTAL_ID` | HubSpot → Settings → *Account* → portal number (legacy Forms fallback) |
| `FORM_GUID` | HubSpot → Marketing → Forms → embed GUID (legacy fallback used only when no private token) |
3. Run `testLead` once → approve the Gmail scopes. Check Gmail for the draft.
4. **Deploy → New deployment → Web app** → Execute as *Me*, Access *Anyone* → copy the `/exec` URL.

Quotas (consumer Gmail): ~100 email recipients/day — plenty for 10–20 personal sends/day.

## 2. Site side (5 min)

In `index.html`, the chat panel and contact form POST to the Apps Script URL.
Set in `js/main.js`:

```js
var CRM_ENDPOINT = 'https://script.google.com/mac/s/XXXX/exec';
var CRM_TOKEN = 'the-TOKEN-from-step-1';
```

(uncomment the provided block in `wireEmailAutomation()` — see below)

Because the browser does a cross-site POST, the Apps Script must be deployed
with Access: *Anyone* (it still needs your TOKEN to do anything).

## 3. Flow after wiring

- Visitor books / leaves details in chat → FSM confirms → site POSTs the lead
  → HubSpot contact created → Gemini drafts a personalized reply → lands in
  your Gmail as a **draft** → you review & press send.
- SME cold outreach: call the same endpoint with `action:'cold'` (or just run
  `handleCold` manually per prospect) → drafted emails with industry-specific
  use cases, your signature, and an opt-out line, every time.

## 4. Lead sentiment with Kev (optional, self-hosted)

Every chat lead can be scored by [Kev](https://github.com/jaredpalmer/kev) — a small,
self-hosted decision model (Jev / TypeSafe System One-compatible) that returns
**calibrated probabilities**, not vibes. For each lead, Apps Script sends the chat
transcript and asks four questions:

| Question | Type | Returns |
|---|---|---|
| Overall sentiment | `choice` | positive / neutral / negative + confidence |
| Is the visitor frustrated? | `noul` | probability |
| Any urgency / deadline? | `noul` | probability |
| Lead heat | `score` | cold / warm / hot |

Results land in three places: a compact `[Kev] …` tag on the HubSpot contact's
message field, a **"— Sentiment (Kev) —"** block in the owner alert email, and a
`mood` field in the endpoint's JSON response.

Setup:

1. Deploy a Kev endpoint (their README's one-command deploy; it scales to zero).
   A local `python -m kev.serve` on your Mac is **not** reachable from Apps
   Script — you need the public HTTPS URL. `kev-0.8b` or `kev-4b` is plenty for
   four questions on a 2.5k-char transcript.
2. Apps Script → Script Properties:
   - `KEV_ENDPOINT` — e.g. `https://your-kev.modal.run` (trailing slash fine)
   - `KEV_MODEL` — optional, default `kev-latest`
   - `KEV_API_KEY` — optional; sent as `Authorization: Bearer …` if your
     deployment enforces one
3. That's it. Unset or unreachable endpoint → sentiment is silently skipped and
   leads flow exactly as before; a slow Kev never blocks lead capture (the
   scoring runs server-side on the lead POST, not in the visitor's browser).

Privacy note: the transcript (last ~2.5k chars of the visitor's chat) is sent to
*your own* Kev deployment and nowhere else.

## Compliance notes (baked in)

- Draft-first: nothing leaves without a human press of Send.
- Every email carries your identity + opt-out line (Spam Control Act / CAN-SPAM).
- No invented claims: the prompt forbids fake clients, results, and metrics.
- Newsletter recipients should come from consent (checkbox on the contact form).

## Cost

$0. Apps Script, Gemini free tier, HubSpot free, Calendly free, GitHub Pages.
