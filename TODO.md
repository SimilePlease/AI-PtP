# TODO

## Wire the Apps Script CRM layer to the live site (code done — needs deploy values)

`js/main.js` already calls `postCRM()` on chat leads and contact-form
submissions, but it stays a no-op until the two config values are filled in.
Blocked on deploying the Apps Script from a Google account (site repo can't do
that) and the two secrets it produces.

- [ ] script.google.com → open the project with `integrations/email-gas/Code.gs`
      (or create it: New project → paste `Code.gs`)
- [ ] Script Properties: `TOKEN` (long random string), `OWNER_EMAIL`,
      HubSpot auth (`HUBSPOT_CLIENT_ID`/`SECRET`/`REDIRECT_URI` via OAuth, or
      legacy `HUBSPOT_PRIVATE_TOKEN`) — full table in
      `integrations/email-gas/README.md`
- [ ] Deploy → New deployment → Web app → Execute as *Me*, Access *Anyone*
      → copy the `/exec` URL
- [ ] Fill in `CRM_ENDPOINT` and `CRM_TOKEN` in `js/main.js` (~line 77–78)
- [ ] Commit, push, verify a chat lead lands as a HubSpot contact with a
      timeline note and an owner-alert email arrives
