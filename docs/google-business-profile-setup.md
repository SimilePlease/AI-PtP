# Google Business Profile — setup sheet (copy-paste ready)

Solo consultant working globally → set this up as a **Service Area Business** (no public
office address shown). Takes ~20 min + Google verification (usually a short video selfie /
business-evidence check for service businesses). Free.

Start at: https://business.google.com/create → "Add your business".

## 1. Business name (pick one)

| Option | Listing name | Why |
|---|---|---|
| **A (recommended)** | `Parag Kudtarkar — AI Strategy & Delivery` | Matches the domain (kudtarkar.life) and email; personal name builds trust for a solo practice |
| B | `AI Pilot to Production` | The public wordmark already on the site — maximum brand consistency |

Whichever you pick, tell me and I'll align the site's JSON-LD `name` to it exactly
(consistency between GBP and the website strengthens both).

Do **not** add keywords like "AI" beyond the descriptor — Google rejects names that
don't match the real-world name.

## 2. Category (most important field for ranking)

- **Primary:** `Computer Consultant` (Google's closest category to AI/tech consulting)
- **Secondary:** `Business Development Consultant`, `Training Consultant`

## 3. Service area (Google asks: do you serve customers at their location? → Yes)

- Hide address: **Yes** (no storefront)
- Service areas (add up to 20): `Singapore`, `Southeast Asia`, `Asia-Pacific`, `Europe`,
  `North America` — or list your priority countries individually

## 4. Description (749 characters — paste as-is)

> AI Pilot to Production is the AI strategy and delivery practice of Parag Kudtarkar,
> a senior technology and transformation executive with more than 22 years of
> experience across healthcare, telecommunications and regulated sectors in APAC.
> The practice helps organisations find the right AI use cases, design and lead AI
> Centres of Excellence, plan AI portfolios, and move pilots into controlled
> production use with responsible AI governance. Engagements range from executive
> strategy workshops and AI readiness assessments to CoE design and delivery
> leadership. Based in Singapore, working globally, remotely and on site.

## 5. Services (add each as a service item, one line each)

- AI Strategy & Use-Case Discovery
- AI Centre of Excellence Design & Leadership
- AI Readiness Assessment
- AI Portfolio Planning & Prioritisation
- Responsible AI & Governance
- AI Delivery Leadership
- AI Literacy & Team Workshops

## 6. Contact & hours

- Phone: skip (a listed number invites spam calls; booking link is the CTA)
- Website: `https://kudtarkar.life` (now live — add once HTTPS is enforced)
- Hours: service businesses with no walk-in — set "No hours" / by appointment
- Appointment links section: `https://calendly.com/kudtarkar-parag/30min`

## 7. Photos (upload on day one)

- Logo: export of `assets/production-orbit-wordmark.svg` (720×720 recommended)
- Cover: `assets/og-image.png`
- Owner: your best headshot (`assets/about-1.jpg` or a professional one)
- Profiles with 5+ photos get significantly more engagement

## 8. Verification

- Likely **video verification**: have ready a government ID + evidence of the business
  (the live website, HubSpot/Calendly screenshots showing the brand, client-facing email)
- Do this promptly — listings ranking is throttled until verified

## 9. After verification (15 min/week)

- Post one "Google Post" weekly (insight, event, or link to an FAQ/article)
- Ask every past client/colleague for a review — the single biggest local-ranking factor
- Seed your own Q&A: "What does an AI consultancy do?" → answer from FAQ Q1
- Check Search Console + GA4 (`book_click`, `contact_form_submit` events) monthly

## 10. Site-side alignment (already in place or pending)

- [x] `ProfessionalService` JSON-LD on the site (name, areaServed, address country SG)
- [x] Custom domain `kudtarkar.life` live (canonical/sitemap/og URLs all point to it)
- [ ] GBP link on the site footer once verified (I'll add the link)
