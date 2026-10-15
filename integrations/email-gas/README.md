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
| `HUBSPOT_PRIVATE_TOKEN` | Optional but recommended — unlocks CRM enrichment. HubSpot → Settings → Integrations → Private Apps → Create ("Orbit enrichment") with scopes: `crm.objects.contacts` **read + write** and `crm.objects.companies` **read + write** (search calls need read; create/update need write; the contact↔company association needs write on both). With this, leads are created/updated via CRM v3 (contact id captured), the lead's **company website is auto-scraped** (title, description, LinkedIn links, tech hints), a HubSpot **Company record is upserted + associated**, and the scraped intel personalises the AI-drafted reply. |
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

## Compliance notes (baked in)

- Draft-first: nothing leaves without a human press of Send.
- Every email carries your identity + opt-out line (Spam Control Act / CAN-SPAM).
- No invented claims: the prompt forbids fake clients, results, and metrics.
- Newsletter recipients should come from consent (checkbox on the contact form).

## Cost

$0. Apps Script, Gemini free tier, HubSpot free, Calendly free, GitHub Pages.
