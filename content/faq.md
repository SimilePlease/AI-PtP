# Orbit FAQ — single source of truth for the chat assistant

This file feeds both halves of the chat system (`js/agent.js`):

1. **LLM path** — `FACT_BLOCKS`/`CORE_PROMPT` in `js/agent.js` quote or paraphrase these answers as "site facts", so the model answers from the same source.
2. **Deterministic path** (lite mode / no WebGPU) — the `ANSWERS` array in `js/agent.js` holds near-verbatim versions keyed by trigger words.

**Rules baked into every answer** (enforced by tests in `tests/`):
- No invented clients, results, prices, dates, or guarantees.
- No numbers except what's on the site (22+ years, five platforms, four geographies, 70 people scaled).
- British English.
- If an answer needs the visitor's context, answer generally, then point to **Book a meeting** / parag@kudtarkar.life.
- Orbit never claims to have booked, sent, or confirmed anything.

When you edit an answer here, mirror the change in `js/agent.js` (both `ANSWERS` and, where relevant, `FACT_BLOCKS`) and run `node tests/agent.test.js` + `node tests/prompts.stress.test.js`.

---

## The practice

**Q: What services does AI-PtP offer?**
A: AI-PtP is an AI strategy and delivery practice. That covers finding the right AI use cases, designing and leading AI Centres of Excellence, planning AI portfolios across industries, product innovation, and taking systems to production — engineered and responsibly deployed.

**Q: Who is behind AI-PtP?**
A: The practice is led by Parag Kudtarkar, a senior technology and transformation executive with more than 22 years of experience. The About section has the full background and a photo carousel.

**Q: What experience does Parag have?**
A: More than 22 years translating business strategy into enterprise-scale digital, technology, data, cloud and AI transformation programmes across healthcare, telecommunications and regulated sectors throughout APAC. He led a multimillion-dollar enterprise transformation across four geographies through a multi-partner delivery model and delivered five production platforms.

**Q: What makes AI-PtP different from bigger consultancies?**
A: You work directly with the person who has done the work — built an AI CoE from greenfield, scaled an AI engineering organisation across four geographies, and taken five clinical AI platforms to regulatory-approved production. No partner hands it to a junior team afterwards.

**Q: Do you sell AI tools or software licences?**
A: No. The practice is advisory and delivery leadership — helping you choose, build, and govern the right systems. It never resells tools or takes commissions on software.

## Industries and clients

**Q: Which industries do you work with?**
A: Healthcare & MedTech, financial services & wealth management, telecommunications, maritime & shipping, and growth businesses/SMEs. The same practical treatment, scaled to fit.

**Q: Do you work with small businesses?**
A: Yes — SMEs get the same evidence-led approach, scaled to fit. The section "AI opportunities for growth businesses" covers realistic first steps.

**Q: Do you work outside Singapore?**
A: Yes. Delivery experience spans APAC, Europe and North America; engagements run remotely and on site where required, across time zones.

## Working together

**Q: How do we start working together?**
A: Book a 30-minute strategic discussion from the Contact section, or use the contact form (or email parag@kudtarkar.life). The first conversation is confidential and there's no obligation.

**Q: What happens in the first conversation?**
A: A 30-minute discussion of your goals, context and timelines — enough to see whether AI is the right lever and what a sensible first step would look like. No sales script, no obligation.

**Q: How long does an engagement last?**
A: It depends on the shape of the work. A strategy review can be a few weeks; a CoE build or a production programme runs longer. You'll get a scoped, specific answer after the first conversation.

**Q: How much does it cost?**
A: It depends on the shape of the work, so no number is quoted in chat. Book a meeting or email parag@kudtarkar.life and you'll get a scoped, specific answer.

**Q: Do you sign NDAs?**
A: Yes. Initial discussions are confidential by default, and NDAs are welcome before you share anything sensitive.

**Q: Do you work remotely or on site?**
A: Both. Engagements run across regions and time zones — remotely, and on site where it matters.

**Q: Can you build the AI solution, or only advise?**
A: Both modes exist. The practice can advise and design, or lead delivery hands-on — strategy, governance, vendor selection, and production build oversight. The right mode depends on your team and context.

**Q: Is Parag available for speaking or advisory roles?**
A: Yes — speaking, advisory and board-level AI guidance are options. Choose "Speaking or advisory" in the contact form or mention it in your email.

## Capability

**Q: What is an AI Centre of Excellence?**
A: A central capability that lets AI actually ship: operating model, talent, platforms, governance, and MLOps/LLMOps. The featured section of this site covers how it's designed and led.

**Q: What is your delivery approach?**
A: Five steps: Discover, Prioritise, Organise, Design and build, Measure and improve. Evidence-led, no theatre.

**Q: What is responsible AI?**
A: Responsible AI rests on three pillars — security (protecting models, data and inputs), governance (ownership, policies, oversight, audit trails), and ethics (fairness, transparency, privacy by design). Governance here is designed for Board assurance, regulatory scrutiny and production accountability.

**Q: Which AI regulations and frameworks do you know?**
A: Framework familiarity includes NIST AI RMF, ISO 42001, the EU AI Act, GDPR, MAS TRM, MAS FEAT, FDA SaMD, HSA, HIPAA and PDPA — familiarity, not certifications.

**Q: Do you offer AI training for teams?**
A: AI literacy and team enablement are part of the CoE work — roles, skills frameworks and literacy programmes. For a focused team workshop, raise it in the first conversation.

## Technical

**Q: What is agentic AI?**
A: AI systems that plan and take multi-step actions toward a goal — calling tools, checking results, adapting — instead of answering one prompt at a time. Done well, it automates real workflows; the craft is choosing the right workflows and governing them.

**Q: Is my data safe when I contact you?**
A: Enquiries go to Parag directly and are used only to respond to you. No selling of data, no marketing lists. Details in the site's privacy approach; NDAs welcome before anything sensitive is shared.

**Q: Can Orbit book a meeting for me?**
A: Orbit can't hold or confirm slots itself — but the "Book a meeting" button opens the real calendar, and the guided flow in chat pre-fills your details so booking takes seconds.
