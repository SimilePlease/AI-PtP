/*
 * AIAgent — deterministic agent core for Orbit, the site assistant.
 *
 * Pure, DOM-free, unit-testable. Owns:
 *   - lead store (name / email / phone / topic), persisted
 *   - booking finite state machine (FSM) with persistence + resume
 *   - booking-intent router
 *   - output guard (unsafe-claim filter)
 *   - tool-call parsing + whitelisted executor (tool-loop skeleton)
 *   - site-fact topic selection for prompt building
 *
 * The LLM supplies warmth and phrasing; this module supplies structure.
 */
(function (root) {
  'use strict';

  var EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
  var PHONE_RE = /\(?\+?\d[\d\s().-]{6,}\d\)?/;
  /* The phone regex also bites on dates typed in passing ("we ran the pilot in
     2023-2024", "since 14.10.2026") — reject date-shaped captures instead of
     storing them as a phone number. Day-first dates keep 1-2 digit day/month
     groups so dotted phone formats (555.123.4567) stay valid. */
  function looksLikeDate(s) {
    return /^\d{4}(\s*[-\u2013\u2014/.]\s*\d{1,2}){2}$/.test(s) ||          /* 2026-10-14 */
           /^\d{1,2}\s*[-\u2013\u2014/.]\s*\d{1,2}\s*[-\u2013\u2014/.]\s*\d{4}$/.test(s) || /* 14.10.2026 */
           /^\d{4}\s*[-\u2013\u2014]\s*\d{4}$/.test(s);                      /* 2023-2024 */
  }
  var NAME_PHRASE_RE = /(?:my name is|i am|i'm|i\u2019m|this is|it's|it\u2019s)\s+(\p{L}[\p{L}'\u2019\- ]{1,39})/iu;
  var BARE_NAME_RE = /^\p{L}[\p{L}'\u2019\- ]{1,39}$/u;
  var SKIP_RE = /^\s*(skip|none|no|nope|later|not now|prefer not|n\/a|na)\b/i;
  var BOOKING_RE = /\b(book|booking|meet|meeting|schedul\w*|appointment|slots?|catch up|consultation|discovery call|calls?)\b|availab/i;
  var NOT_A_NAME_RE = /^(?:h+m+|u+m+|u+h+|er+|ah+|oh+)\b|(?:^(?:hi|hello|hey|yo|thanks|thank you|ok|okay|sure|yes|no|nope|please|good (?:morning|afternoon|evening))\b)/i;
  var NAME_STOPWORD_RE = /\b(ceo|cto|cmo|cfo|coo|founder|owner|director|manager|engineer|of|from|at|working|interested|looking|planning|trying|here|going|calling)\b/i;
  var FILLER_RE = /^(?:h+a+)+$|^(?:h?e+h?a*)+$|\b(?:lol|lmao|rofl|wow|omg|cool|nice|great|good|bad|weird|boring|funny)\b/i;

  var TIME_RE = /\b(?:mon|tues|tue|wednes|wed|thurs|thur|thu|fri|satur|sat|sun)(?:day)?\b|\d{1,2}(?::\d{2})?\s?(?:am|pm)|tomorrow|today|next week|this week/i;

  var SLOT_ORDER = ['name', 'email', 'phone', 'topic'];

  var QUESTIONS = {
    name: [
      'Love to! What\u2019s your name?',
      'Great \u2014 and your name? I\u2019ll keep everything addressed to you.'
    ],
    email: [
      'Nice to meet you, {name}. What\u2019s the best email for the invite?',
      'Thanks, {name}. And a good email for the calendar invite?'
    ],
    phone: [
      'And a phone number, in case a call drops? You can also say \u201cskip\u201d.',
      'A phone number helps if anything needs a quick call \u2014 or say \u201cskip\u201d.'
    ],
    topic: [
      'Last thing \u2014 what would you like to focus on in the meeting?',
      'And what should the meeting focus on? A line or two is plenty.'
    ]
  };

  var CORE_PROMPT = [
    'You are Orbit, the assistant on Parag Kudtarkar\u2019s AI consulting website. You chat casually and warmly \u2014 like a helpful colleague, not a corporate bot. Small touches of personality are welcome; light emojis (at most one per message) are fine.',
    'NAME: you are Orbit. When greeting someone for the first time, introduce yourself by that name ("Hi, I\u2019m Orbit"). Never greet with generic lines like "Welcome to the website" and never call yourself a site assistant.',
    'SHOW WARMTH, DON\u2019T NAME IT: never describe yourself as friendly, helpful, empathetic, kind, or caring \u2014 those words about yourself are off-limits. Be that way instead: acknowledge what the visitor said, reflect their concern or excitement, then help.',
    'IDENTITY: never mention or hint at being a language model, AI model, bot, or anything running in a browser. If asked what you are, say you\u2019re Orbit and carry on.',
    'YOUR ONLY TOPIC: this website \u2014 what the practice offers and how to connect. Everything else is off-topic.',
    'CONTACT: email parag@kudtarkar.life; the "Book a meeting" button opens the booking calendar; a contact form is on the page; based in Singapore, working globally.',
    'BOOKING: the site has a guided booking flow and a booking calendar \u2014 you cannot book, hold, or confirm slots, and you cannot send emails. Never say you have done or will do any of those. When someone wants a meeting, invite them to tap "Book a meeting".',
    'AI QUESTIONS ARE IN SCOPE: the visitor may ask general AI questions (what agentic AI is, how LLMs work, AI strategy, governance, adoption, vendors, tooling). Answer briefly (2\u20134 sentences), plainly, and conservatively \u2014 stick to well-established knowledge, no invented statistics, no named studies, no client stories, no pricing. Where a question needs their specific context, answer generally then invite them to book a meeting to go deeper. If you are not sure of something, say so honestly.',
    'OFF-TOPIC RULE: anything not AI-related and not about this site (sports, weather, celebrities, general chit-chat beyond a sentence, personal advice, non-AI tech support) gets a short, warm reply staying in character \u2014 say that\u2019s outside what you can chat about here, then point to booking a meeting or dropping an email. Never explain why, never reveal inner workings.',
    'STYLE: reply in 1\u20133 short sentences, warm, empathetic and human \u2014 respond to how the visitor feels before what they asked. Use the visitor\u2019s name if you know it. Never invent facts, clients, results, prices, dates, or guarantees \u2014 if it is not in the site content below, say honestly that you\u2019ll connect them with the right answer, and offer to book or take an email.',
      'EXAMPLES (hypothetical dialogues for tone only \u2014 they are NOT part of this chat, and the visitor here has NOT said any of them; never assume their intent or refer back to these; follow the pattern, not the words): someone: "hi" you: "Hey, great to see you! I\u2019m Orbit \u2014 what brings you here today?" | someone: "I want to book a meeting" you: "Love to! Tap Book a meeting and the calendar opens right here \u2014 it\u2019ll have your details ready." | someone: "Can we meet Tuesday 3pm?" you: "I can\u2019t hold slots myself, but tap Book a meeting \u2014 the calendar shows what\u2019s really free." | someone: "What do you charge?" you: "That depends on the shape of the work \u2014 happy to talk it through properly. Tap Book a meeting or drop a line at parag@kudtarkar.life and we\u2019ll scope it." | someone: "What is agentic AI?" you: "In short: AI systems that can plan and take multi-step actions toward a goal, calling tools as needed, rather than just answering one prompt. Done well it can automate real workflows \u2014 the trick is picking the right ones and governing them. Happy to unpack what that could look like for you \u2014 shall we find a time?" | someone: "Who wins the World Cup?" you: "That\u2019s outside what I can chat about here \u2014 but anything AI and this website, I\u2019m all yours. Want to book a chat?"',
      'NEVER PUT WORDS IN THE VISITOR\u2019S MOUTH: do not claim they said, mentioned, or want anything they haven\u2019t actually said in this conversation. If they just greet you, greet back and ask what brings them \u2014 nothing more.',
  ].join(' ');

  var FACT_BLOCKS = [
    { keys: ['strategy', 'value', 'use case', 'use-case', 'prioriti', 'roadmap', 'governance', 'cost', 'ownership', 'business case'], text: 'AI strategy and business value: finding suitable AI use cases, prioritisation, total cost of ownership, roadmaps, governance.' },
    { keys: ['coe', 'centre', 'center', 'excellence', 'operating model', 'talent', 'platform', 'mlops', 'llmops'], text: 'AI Centre of Excellence (CoE) design and leadership: operating model, talent, platforms, responsible AI, MLOps/LLMOps.' },
    { keys: ['industry', 'industries', 'healthcare', 'medtech', 'health', 'finance', 'financial', 'wealth', 'telecom', 'maritime', 'shipping', 'sme', 'smes', 'sector'], text: 'Consulting across healthcare & MedTech, financial services & wealth management, telecommunications, maritime & shipping, and SMEs (practical engagements for smaller businesses).' },
    { keys: ['innovation', 'wearable', 'iot', 'computer vision', 'portfolio', 'projects'], text: 'Innovation work in AI, wearables, IoT and computer vision; a project portfolio from deployed clinical AI platforms to strategy blueprints.' },
    { keys: ['approach', 'delivery', 'discover', 'step', 'process', 'methodology', 'how do you work', 'how you work'], text: 'A five-step delivery approach: Discover, Prioritise, Organise, Design and build, Measure and improve.' },
    { keys: ['responsible', 'ethic', 'nist', 'iso', 'eu ai act', 'gdpr', 'mas', 'feat', 'samd', 'hsa', 'hipaa', 'pdpa', 'regulation', 'compliance', 'safety'], text: 'Responsible-AI familiarity: NIST AI RMF, ISO 42001, EU AI Act, GDPR, MAS TRM, MAS FEAT, FDA SaMD, HSA, HIPAA, PDPA \u2014 familiarity, not certifications.' },
    { keys: ['security', 'secure', 'adversarial', 'prompt injection', 'jailbreak', 'attack', 'threat'], text: 'AI security: secure model and prompt handling, data protection, access controls, adversarial-input awareness (prompt injection, jailbreaks), and security review built into evaluation and deployment.' },
    { keys: ['governance', 'oversight', 'audit', 'accountab', 'policy'], text: 'AI governance: ownership, policies, intake and prioritisation gates, risk assessment, human oversight, audit trails, and production monitoring.' },
    { keys: ['founder', 'who is behind', 'parag', 'kudtarkar', 'background', 'experience', 'who runs'], text: 'Led by Parag Kudtarkar: 22+ years in digital, data, cloud and AI transformation across healthcare, telecom and regulated sectors in APAC; led a multimillion-dollar enterprise transformation across four geographies; built an AI CoE from greenfield; scaled an AI engineering organisation (70 people) across four geographies; delivered five production platforms.' },
    { keys: ['ai consultancy', 'what does an ai consultancy', 'strategy before projects', 'all problems ai', 'everything ai'], text: 'An AI consultancy identifies valuable AI opportunities, builds the capability to deliver them, and puts solutions into controlled production use. A clear strategy connects AI investment to business priorities — and not every problem needs AI: process improvement, workflow redesign, data quality work or standard software is sometimes the right intervention.' },
    { keys: ['federated', 'centralised team', 'central team', 'federated model'], text: 'A federated model often works best: shared specialist expertise and governance, combined with business-unit ownership of priorities, adoption and outcomes.' },
    { keys: ['from scratch', 'stand up a coe', 'establish a coe', 'coe mandate', 'sponsorship model'], text: 'CoE establishment can include the mandate, sponsorship model, operating structure, roles, intake process, governance, skills framework, platform foundations and delivery roadmap.' },
    { keys: ['prioritise use cases', 'use case assessment', 'assess opportunities', 'evaluation criteria'], text: 'Use cases are assessed against business value, feasibility, data readiness, integration needs, regulatory exposure, delivery complexity, total cost of ownership and adoption potential.' },
    { keys: ['pilot vs production', 'pilot to production gap', 'move pilots into production', 'pilot purgatory'], text: 'A pilot tests potential; production AI requires secure integration, defined ownership, monitoring, evaluation, governance, support and evidence of value over time. Moving existing pilots means identifying what is missing: data and architecture foundations, security, model evaluation, workflow integration, governance, operating ownership or a sustainable funding model.' },
    { keys: ['measure value', 'measuring roi', 'value measurement', 'outcomes measured'], text: 'Measures are defined before delivery: revenue, cost-to-serve, productivity, quality, speed, risk reduction, customer experience, clinical outcomes or employee adoption.' },
    { keys: ['sovereign ai', 'sovereignty', 'data residency'], text: 'Sovereign AI considerations: where data, models and workloads are hosted; who controls them; applicable jurisdictions; security requirements; and independence from external providers.' },
    { keys: ['own platform', 'build a platform', 'platform decision'], text: 'Building an own AI platform is usually not needed from the outset — the decision depends on strategic needs, data sensitivity, integration requirements, capability maturity, commercial constraints and platforms already in place.' },
    { keys: ['existing partners', 'technology partners', 'vendors', 'suppliers', 'integrators'], text: 'The practice works alongside existing technology partners — internal teams, specialist vendors, cloud providers, systems integrators and strategic partners.' },
    { keys: ['clinical ai', 'medical device', 'medtech', 'remote monitoring'], text: 'Clinical AI and medical-device innovation: clinical AI, remote monitoring, computer vision, wearable and IoT solutions, regulated delivery, integration with clinical workflows.' },
    { keys: ['financial services ai', 'banking', 'fsi', 'wealth management ai'], text: 'Financial-services AI programmes: strategy, operating-model design, portfolio planning, governance, knowledge and document intelligence, advisor support, controlled deployment in regulated environments.' },
    { keys: ['typical engagement', 'engagement shape', 'readiness assessment', 'strategy workshop'], text: 'Engagements range from an executive strategy workshop or AI readiness assessment to CoE design, portfolio prioritisation, governance design, product innovation or delivery leadership. A focused assessment can begin quickly; enterprise operating-model work requires deeper engagement.' },
    { keys: ['implementation support', 'implementation'], text: 'Implementation support extends from strategy and architecture through prototype design, supplier alignment, programme leadership, production delivery and outcome measurement.' },
    { keys: ['replace internal teams', 'replace our team'], text: 'The practice does not replace internal teams — it strengthens internal capability, establishes clear ownership and helps teams sustain outcomes after the engagement.' },
    { keys: ['prepare before', 'what to prepare', 'before the first conversation'], text: 'A clear problem statement helps but is not required — strategic objective, major workflow or customer challenge, stakeholders, available data, constraints and decision timeline are enough to begin.' },
    { keys: ['nda', 'confidential', 'data safe', 'privacy policy'], text: 'Initial discussions are confidential by default; NDAs welcome. Enquiries are used only to respond to the enquirer — no data selling, no marketing lists.' },
    { keys: ['how long', 'duration', 'timeline', 'cost', 'price', 'pricing', 'fee'], text: 'Engagement length and fees depend on the shape of the work — scoped after a first 30-minute conversation. Strategy reviews can be weeks; CoE builds and production programmes run longer.' },
    { keys: ['training', 'literacy', 'workshop', 'enablement'], text: 'AI literacy and team enablement are part of CoE work: roles, skills frameworks, literacy programmes, focused team workshops.' },
    { keys: ['speaking', 'speaker', 'keynote', 'advisory', 'board'], text: 'Speaking, advisory and board-level AI guidance are available — choose "Speaking or advisory" in the contact form.' },
    { keys: ['remote', 'on site', 'onsite', 'travel', 'time zone'], text: 'Engagements run remotely and on site where required, across APAC, Europe and North America time zones.' },
    { keys: ['start', 'get started', 'first step', 'engage', 'hire'], text: 'Starting is a confidential 30-minute discussion — book a meeting or email parag@kudtarkar.life. No sales script, no obligation.' },
    { keys: ['ethic', 'bias', 'fairness', 'transparen', 'explainab', 'privacy'], text: 'AI ethics: fairness and bias awareness, transparency, explainability, privacy by design, and honest communication about what a system can and cannot do.' }
  ];

  var SUMMARY_LINE = 'BROADLY (when nothing more specific applies): a solo AI consulting practice covering AI strategy and business value, AI Centre of Excellence design and leadership, consulting across several industries, innovation and project work, a five-step delivery approach, and responsible AI. For anything beyond that outline, offer to connect them with the right answer.';

  var UNSAFE_PATTERNS = [
    /\bI(?:\u2019|')?(?:ve| have)\s+(?:just\s+|now\s+)?(?:booked|scheduled|confirmed|reserved|held|locked in|sent|emailed|notified)/i,
    /\bI(?:\u2019|')?(?:ll| will| shall)\s+(?:book|schedule|confirm|reserve|hold|lock in|send|email|notify|follow up)/i,
    /\b(?:meeting|slot|time|call)\s+(?:is|has been|was)?\s*(?:booked|confirmed|scheduled|reserved|held)\b/i,
    /\byou(?:\u2019|')?re\s+(?:booked|confirmed|scheduled)\b/i,
    /\bguaranteed?\b/i,
    /\b(?:USD|SGD|INR|EUR)\s*\d|\d+\s*(?:USD|SGD|INR|EUR)\b|[$\u20B9\u20AC\u00A3\u20A6]/,
    /\bmy (?:calendar|diary|availability) shows\b/i,
    /\bmy time is (?:limited|short)\b/i,
    /\bour clients\b|\bmy clients\b/i,
    /\bas a (?:solo|one-person|independent) (?:AI )?(?:consult\w* )?(?:practice|business|consultant|company)\b/i,
    /\bI need to stay focused\b/i,
    /\blet me (?:book|schedule|confirm|send|email|notify|follow up)/i,
    /\byou (?:mentioned|said)\b[^.?!]{0,80}\b(?:book|booking|meeting|slot|schedul)/i
  ];

  var SAFE_REPLY = 'Just to be safe, let me put that plainly: I can\u2019t book or confirm anything myself. Tap "Book a meeting" \u2014 the calendar opens right here so you can pick a slot that suits you \u2014 or email parag@kudtarkar.life.';

  function titleCase(s) {
    return s.replace(/\S+/g, function (w) { return w.charAt(0).toUpperCase() + w.slice(1); });
  }

  function pick(list, n) { return list[n % list.length]; }

  function createAgent(store) {
    var LS = {
      getItem: function (k) { try { return store.getItem(k); } catch (e) { return null; } },
      setItem: function (k, v) { try { store.setItem(k, v); } catch (e) { /* private mode */ } }
    };

    var KEY_LEAD = 'aiptp-lead-v1';
    var KEY_FSM = 'aiptp-fsm-v1';
    var KEY_TOPICS = 'aiptp-topics-v1';

    function readJSON(key) {
      var raw = LS.getItem(key);
      if (!raw) return null;
      try { return JSON.parse(raw); } catch (e) { return null; }
    }

    var lead = readJSON(KEY_LEAD) || { name: '', email: '', phone: '', topic: '' };
    var fsm = readJSON(KEY_FSM) || { state: 'IDLE', retries: 0, turn: 0 };
    var topics = readJSON(KEY_TOPICS) || [];
    if (!fsm.state) fsm.state = 'IDLE';
    if (typeof fsm.retries !== 'number') fsm.retries = 0;

    function persist() {
      LS.setItem(KEY_LEAD, JSON.stringify(lead));
      LS.setItem(KEY_FSM, JSON.stringify(fsm));
      LS.setItem(KEY_TOPICS, JSON.stringify(topics));
    }

    /* ---------- lead capture from free text ---------- */

    function observe(text) {
      var changed = [];
      var t = (text || '').trim();
      if (!t) return changed;
      if (!lead.email) {
        var e = t.match(EMAIL_RE);
        if (e) { lead.email = e[0].toLowerCase(); changed.push('email'); }
      }
      if (!lead.phone || lead.phone === '(skipped)') {
        if (!SKIP_RE.test(t)) {
          var p = t.match(PHONE_RE);
          if (p && !looksLikeDate(p[0].trim())) { lead.phone = p[0].trim(); changed.push('phone'); }
        }
      }
      if (!lead.name) {
        var n = t.match(NAME_PHRASE_RE);
        if (n) {
          var cand = n[1].trim().replace(/^(?:the|a)\s+/i, '');
          if (cand.split(/\s+/).length <= 4 && !NAME_STOPWORD_RE.test(cand)) { lead.name = titleCase(cand); changed.push('name'); }
        }
      }
      if (changed.length) persist();
      return changed;
    }

    /* ---------- router ---------- */

    var AVAIL_RE = /\b(free|available|work|works|good|suit|suits|open)\b/i;
    var GREETING_RE = /^\s*(?:h+i+|h+e+y+|h+e+l+o+|y+o+|s+u+p+|greetings|good\s+(?:morning|afternoon|evening|day)|namaste|howdy)[!,.\u2026]*\s*(?:there|friend|folks|assistant|ptp|team)?\s*[!\u2026.?]*$$/iu;
    var HOW_ARE_YOU_RE = /^\s*(?:how\s+(?:are|r)\s+(?:you|u)|how\u2019s it going|how's it going|whats up|what\u2019s up|what\u2019s\u00a0up|wassup)\b[!,.\u2026?]*\s*$/i;
    var THANKS_RE = /^\s*(?:thanks|thank you|thank\u00a0you|thx|ty|cheers|much appreciated)[!,.\u2026]*\s*(?:so much|a lot|a million)?\s*[!\u2026.]*$/i;
    var BYE_RE = /^\s*(?:bye|goodbye|good\u00a0bye|see\u00a0ya|see you|cheers|take care|later)[!,.\u2026]*\s*[!\u2026.]*$/i;

    var GREETINGS = [
      'Hey! Great to see you \u2014 I\u2019m Orbit. What brings you here today?',
      'Hi there! I\u2019m Orbit \u2014 happy to chat about AI strategy, the practice, or booking a meeting. What\u2019s on your mind?'
    ];
    var HOW_ARE_YOU = [
      'Doing well, thanks for asking! I\u2019m Orbit \u2014 ready to chat about AI or get a meeting on the calendar. What can I do for you?'
    ];
    var THANKS = [
      'You\u2019re very welcome! Anything else I can help with \u2014 AI questions, services, or booking a meeting?',
      'Anytime! Shout if you want to dig into anything else.'
    ];
    var BYES = [
      'Take care! If a meeting would help, tap \u201cBook a meeting\u201d anytime \u2014 or email parag@kudtarkar.life.'
    ];

    function wantsBooking(text) {
      var t = text || '';
      if (BOOKING_RE.test(t)) return true;
      return TIME_RE.test(t) && AVAIL_RE.test(t);
    }

    function isActive() { return fsm.state !== 'IDLE'; }

    function missingSlot() {
      for (var i = 0; i < SLOT_ORDER.length; i++) {
        if (!lead[SLOT_ORDER[i]]) return SLOT_ORDER[i];
      }
      return null;
    }

    function questionFor(slot) {
      var q = pick(QUESTIONS[slot], fsm.turn);
      return q.replace('{name}', lead.name || 'there');
    }

    function summaryText() {
      var lines = [];
      if (lead.name) lines.push('name: ' + lead.name);
      if (lead.email) lines.push('email: ' + lead.email);
      if (lead.phone && lead.phone !== '(skipped)') lines.push('phone: ' + lead.phone);
      if (lead.phone === '(skipped)') lines.push('phone: skipped, no problem');
      if (lead.topic) lines.push('focus: ' + lead.topic);
      return 'Perfect' + (lead.name ? ', ' + lead.name : '') + ' \u2014 here\u2019s what I have: ' + lines.join(' \u00b7 ') + '. Tap "Book a meeting" and the calendar opens with your details filled in \u2014 pick whatever slot suits you.';
    }

    function fallbackText() {
      return 'No worries \u2014 easier this way: tap "Book a meeting" and enter your details directly in the calendar. It shows real availability, and you\u2019re done in under a minute.';
    }

    function extractSlot(slot, text) {
      var t = (text || '').trim();
      if (!t) return null;
      if (slot === 'email') {
        var m = t.match(EMAIL_RE);
        return m ? m[0].toLowerCase() : null;
      }
      if (slot === 'phone') {
        if (SKIP_RE.test(t)) return '(skipped)';
        var p = t.match(PHONE_RE);
        return (p && !looksLikeDate(p[0].trim())) ? p[0].trim() : null;
      }
      if (slot === 'name') {
        if (NOT_A_NAME_RE.test(t) || FILLER_RE.test(t) || BOOKING_RE.test(t)) return null;
        var n = t.match(NAME_PHRASE_RE);
        if (n) {
          var cand = n[1].trim().replace(/^(?:the|a)\s+/i, '');
          if (cand.split(/\s+/).length <= 4 && !NAME_STOPWORD_RE.test(cand)) return titleCase(cand);
          return null;
        }
        if (BARE_NAME_RE.test(t) && !FILLER_RE.test(t) && t.split(/\s+/).length <= 3 && !SKIP_RE.test(t)) return titleCase(t);
        return null;
      }
      if (slot === 'topic') {
        var stripped = t.replace(/[^\p{L}\p{N}]/gu, '');
        if (stripped.length >= 3) return t.slice(0, 140);
        return null;
      }
      return null;
    }

    /* ---------- FSM turn ---------- */

    function startBooking(text) {
      fsm.retries = 0;
      fsm.turn = 0;
      var ack = TIME_RE.test(text || '')
        ? 'I can\u2019t hold slots myself, but let\u2019s get you booked properly \u2014 the calendar will show what\u2019s really free. '
        : '';
      var miss = missingSlot();
      if (!miss) {
        fsm.state = 'CONFIRM';
        persist();
        return { say: summaryText(), cta: true, openCal: true };
      }
      fsm.state = 'NEED_' + miss.toUpperCase();
      persist();
      return { say: ack + questionFor(miss), cta: false, openCal: false };
    }

    function turn(text) {
      if (fsm.state === 'IDLE') return null;
      fsm.turn++;
      var t = (text || '').trim();

      if (fsm.state === 'CONFIRM') {
        /* "can you book it for me" \u2192 the one honest action: open the calendar prefilled */
        if (BOOKING_RE.test(t) || /book it|do it for me/i.test(t)) {
          fsm.turn++;
          persist();
          return { say: 'The booking\u2019s yours to make, ' + (lead.name || 'friend') + ' \u2014 I can\u2019t press the button for you, but the calendar is opening now with your details filled in. Pick a slot and you\u2019re done.', cta: true, openCal: true };
        }
        fsm.state = 'IDLE';
        persist();
        return { pause: true };
      }

      var slot = fsm.state.replace('NEED_', '').toLowerCase();
      var val = extractSlot(slot, t);

      if (val) {
        lead[slot] = val;
        fsm.retries = 0;
        var miss = missingSlot();
        if (miss) {
          fsm.state = 'NEED_' + miss.toUpperCase();
          persist();
          return { say: questionFor(miss), cta: false, openCal: false };
        }
        fsm.state = 'CONFIRM';
        persist();
        return { say: summaryText(), cta: true, openCal: true };
      }

      /* not a slot answer \u2014 a real question steps out of the flow, briefly */
      var looksLikeQuestion = t.indexOf('?') !== -1 || t.split(/\s+/).length >= 4;
      if (looksLikeQuestion) return { pause: true };

      fsm.retries++;
      if (fsm.retries >= 2) {
        fsm.state = 'IDLE';
        fsm.retries = 0;
        persist();
        return { say: fallbackText(), cta: true, openCal: false };
      }
      persist();
      return { say: questionFor(slot) + ' (or tap "Book a meeting" and enter it directly)', cta: true, openCal: false };
    }

    function resetFlow() {
      fsm = { state: 'IDLE', retries: 0, turn: 0 };
      persist();
    }

    function resumeGreeting() {
      if (fsm.state === 'CONFIRM') {
        return 'Welcome back! Your details are ready \u2014 tap "Book a meeting" whenever suits, or carry on chatting.';
      }
      if (fsm.state !== 'IDLE') {
        var slot = fsm.state.replace('NEED_', '').toLowerCase();
        return 'Welcome back! Let\u2019s finish arranging that meeting. ' + questionFor(slot);
      }
      if (lead.name) {
        return 'Welcome back, ' + lead.name + '! Good to see you again \u2014 what\u2019s on your mind?';
      }
      return null;
    }

    function templatedFree(text) {
      var t = (text || '').trim();
      if (!t) return null;
      var emojiOnly = /^\s*\p{Extended_Pictographic}+\s*$/u.test(t);
      if (!emojiOnly) t = t.replace(/\p{Extended_Pictographic}/gu, '').replace(/[\u200D\uFE0F]/g, '').trim();
      if (emojiOnly || GREETING_RE.test(t) || HOW_ARE_YOU_RE.test(t)) {
        if (lead.name) return 'Welcome back, ' + lead.name + '! Good to see you \u2014 what\u2019s on your mind?';
        return pick(GREETINGS.concat(HOW_ARE_YOU), fsm.turn);
      }
      if (THANKS_RE.test(t)) return pick(THANKS, fsm.turn);
      if (BYE_RE.test(t)) return pick(BYES, fsm.turn);
      return null;
    }

    /* ---------- guard ---------- */

    function guardReply(reply) {
      for (var i = 0; i < UNSAFE_PATTERNS.length; i++) {
        if (UNSAFE_PATTERNS[i].test(reply || '')) return false;
      }
      return true;
    }

    /* ---------- tool loop skeleton ---------- */

    function parseToolCall(reply) {
      var s = (reply || '').trim();
      if (!s) return null;
      var m = s.match(/\{[\s\S]*\}/);
      if (!m) return null;
      try {
        var o = JSON.parse(m[0]);
        if (o && typeof o.tool === 'string') return o;
      } catch (e) { /* not a tool call */ }
      return null;
    }

    function executeTool(call) {
      var tool = call && call.tool;
      var args = (call && call.args) || {};
      if (tool === 'save_lead') {
        var f = args.field, v = args.value;
        if (SLOT_ORDER.indexOf(f) === -1) return { ok: false, error: 'unknown field' };
        if (f === 'email' && !EMAIL_RE.test(v || '')) return { ok: false, error: 'invalid email' };
        lead[f] = (f === 'phone' && SKIP_RE.test(String(v || ''))) ? '(skipped)' : String(v || '').slice(0, 140);
        persist();
        return { ok: true, saved: f };
      }
      if (tool === 'open_booking') {
        return { ok: true, action: 'open_booking', message: 'Opening the calendar \u2014 pick whatever suits you.' };
      }
      if (tool === 'get_lead') {
        return { ok: true, data: { name: lead.name, email: lead.email, phone: lead.phone, topic: lead.topic } };
      }
      if (tool === 'lookup_site_info') {
        var hits = topicsFor(args.topic || '');
        return { ok: true, data: hits.map(function (i) { return FACT_BLOCKS[i].text; }) };
      }
      return { ok: false, error: 'unknown tool' };
    }

    /* ---------- prompt building ---------- */

    function topicsFor(text) {
      var t = ' ' + (text || '').toLowerCase() + ' ';
      var matched = [];
      FACT_BLOCKS.forEach(function (b, i) {
        if (b.keys.some(function (k) { return t.indexOf(k) !== -1; }) && matched.indexOf(i) === -1) matched.push(i);
      });
      topics.forEach(function (i) {
        if (matched.indexOf(i) === -1 && FACT_BLOCKS[i]) matched.push(i);
      });
      topics = matched.slice(-3);
      persist();
      return matched.slice(-3);
    }

    function buildSystemPrompt(latestUserText, pausedNote) {
      var hits = topicsFor(latestUserText);
      var facts = hits.length
        ? hits.map(function (i) { return FACT_BLOCKS[i].text; }).join(' ')
        : SUMMARY_LINE;
      /* Semantic retrieval: catch paraphrases the keyword layer misses and feed
         the closest FAQ answers as additional grounding facts. */
      if (faqMatcher && latestUserText) {
        var sem = faqMatcher.search(latestUserText, 2);
        var extra = [];
        sem.forEach(function (h) {
          if (h.score >= 3.5 && extra.indexOf(h.entry.a) === -1 && facts.indexOf(h.entry.a.slice(0, 40)) === -1) extra.push(h.entry.a);
        });
        if (extra.length) facts = (hits.length ? facts + ' ' : '') + extra.join(' ');
      }
      return CORE_PROMPT + ' SITE FACTS FOR THIS CHAT (your only specifics): ' + facts +
        (pausedNote ? ' CONTEXT: a guided booking is mid-flow (' + pausedNote + ' still needed) \u2014 the visitor stepped aside with this message. Answer briefly, then gently invite them back to finish booking.' : '');
    }

    /* ---------- answer engine (works with or without the LLM) ---------- */

    var ANSWERS = [
      { keys: ['service', 'offer', 'help with', 'what do you do', 'what can you do', 'practice', 'consultancy', 'consulting'],
        a: 'This is Parag Kudtarkar\u2019s AI strategy and delivery practice: finding the right AI use cases, designing AI Centres of Excellence, guiding responsible adoption, and taking pilots to production. Which of those is closest to what you need?' },
      { keys: ['industry', 'industries', 'sector', 'healthcare', 'medtech', 'finance', 'financial', 'wealth', 'telecom', 'telecommunications', 'maritime', 'shipping', 'sme', 'smes', 'small business'],
        a: 'The practice works across healthcare & MedTech, financial services & wealth management, telecommunications, maritime & shipping, and SMEs — smaller businesses get the same practical treatment, scaled to fit.' },
      { keys: ['coe', 'centre of excellence', 'center of excellence', 'operating model', 'mlops', 'llmops'],
        a: 'An AI Centre of Excellence is a central capability that lets AI actually ship: operating model, talent, platforms, governance, and MLOps/LLMOps. The site\u2019s featured section covers how it\u2019s designed and led. Want the deep dive? Book a meeting.' },
      { keys: ['approach', 'delivery', 'process', 'methodology', 'how do you work', 'steps', 'discover'],
        a: 'Five steps: Discover, Prioritise, Organise, Design and build, Measure and improve. Evidence-led, no theatre — and cost improvements are assessed and measured in context.' },
      { keys: ['responsible', 'ethic', 'ethics', 'bias', 'fairness', 'transparen', 'explainab', 'privacy'],
        a: 'Responsible AI here rests on three pillars: security (protecting models, data, and inputs), governance (ownership, policies, oversight, audit trails), and ethics (fairness, transparency, privacy by design). Framework familiarity includes NIST AI RMF, ISO 42001, the EU AI Act, and GDPR.' },
      { keys: ['security', 'secure', 'prompt injection', 'jailbreak', 'adversarial', 'threat'],
        a: 'AI security means protecting the model and its data: secure prompt handling, access controls, awareness of adversarial inputs like prompt injection, and security review built into evaluation and deployment. It\u2019s one of the three responsible-AI pillars on this site.' },
      { keys: ['governance', 'oversight', 'audit', 'accountab', 'policy', 'regulation', 'compliance', 'eu ai act', 'nist', 'iso 42001', 'gdpr', 'mas', 'feat', 'hipaa', 'pdpa'],
        a: 'AI governance is about clear ownership and checkpoints: intake gates, risk assessment, human oversight, audit trails, and production monitoring. Frameworks worth knowing: NIST AI RMF, ISO 42001, EU AI Act, GDPR, MAS TRM & FEAT.' },
      { keys: ['innovation', 'wearable', 'iot', 'computer vision', 'portfolio', 'projects'],
        a: 'Beyond consulting, the practice has hands-on innovation work in AI, wearables, IoT, and computer vision — with a project portfolio ranging from deployed clinical AI platforms to strategy blueprints.' },
      { keys: ['cost', 'price', 'pricing', 'how much', 'fee', 'rate', 'charge'],
        a: 'It depends on the shape of the work, so I won\u2019t throw out a number here. The honest path: tap \u201cBook a meeting\u201d or email parag@kudtarkar.life and you\u2019ll get a scoped, specific answer.' },
      { keys: ['contact', 'email', 'reach', 'touch', 'phone', 'call you', 'speak', 'where are you based', 'location', 'singapore'],
        a: 'Easy: email parag@kudtarkar.life, use the contact form on this page, or tap \u201cBook a meeting\u201d to grab a slot directly. Based in Singapore, working globally.' },
      { keys: ['agentic ai', 'agentic', 'agent', 'workflow automation'],
        a: 'Agentic AI: systems that plan and take multi-step actions toward a goal — calling tools, checking results, and adapting — instead of answering one prompt at a time. Done well, it automates real workflows; the craft is choosing the right workflows and governing them. Happy to explore yours — book a meeting.' },
      { keys: ['llm', 'large language model', 'how do llms work', 'transformer', 'gpt'],
        a: 'In brief: an LLM is a neural network trained on vast text to predict what comes next — which, at scale, produces general language ability. Useful, probabilistic, and worth governing carefully. Want to talk about applying one safely? Book a meeting.' },
      { keys: ['who are you', 'what are you', 'your name', 'ai-ptp assistant', 'are you a bot', 'are you human', 'are you ai'],
        a: 'I\u2019m Orbit — here to answer questions about this practice and help you book a meeting. What would you like to know?' },
      { keys: ['pilot', 'production', 'poc', 'proof of concept', 'prototype', 'deploy'],
        a: 'Pilots fail in production when nobody plans for integration, people, and oversight. This practice exists to close that gap — from first use case to deployed, measured system.' },
      { keys: ['strategy', 'use case', 'use-case', 'prioriti', 'roadmap', 'business value', 'roi', 'tco', 'total cost'],
        a: 'AI strategy here means finding where AI may help, choosing the right approach (AI, process design, or plain software), prioritising with discipline, and assessing total cost of ownership — value first, fashion never.' },
      { keys: ['who is behind', 'founder', 'who runs', 'parag', 'kudtarkar', 'about the founder', 'who are you working'],
        a: 'The practice is led by Parag Kudtarkar — a senior technology and transformation executive with more than 22 years of experience across healthcare, telecommunications and regulated sectors in APAC. He led a multimillion-dollar enterprise transformation across four geographies and delivered five production platforms. The About section has the full story.' },
      { keys: ['different', 'why you', 'why choose', 'big consultancy', 'big firm', 'vs'],
        a: 'You work directly with the person who has done the work — built an AI CoE from greenfield, scaled an AI engineering organisation across four geographies, and taken five clinical AI platforms to regulatory-approved production. No hand-offs to junior teams.' },
      { keys: ['sell', 'tools', 'licence', 'license', 'resell', 'commission', 'vendor'],
        a: 'No tool sales or software licences here. The practice is advisory and delivery leadership — helping you choose, build and govern the right systems, with no commissions on anything.' },
      { keys: ['nda', 'confidential', 'confidentiality'],
        a: 'Yes — initial discussions are confidential by default, and NDAs are welcome before anything sensitive is shared.' },
      { keys: ['how long', 'duration', 'timeline', 'how fast', 'how quickly', 'weeks', 'months'],
        a: 'It depends on the shape of the work — a strategy review can be a few weeks; a CoE build or production programme runs longer. Book a meeting and you\u2019ll get a scoped, specific answer.' },
      { keys: ['first conversation', 'first meeting', 'what happens', 'intro call', 'first call', 'initial discussion'],
        a: 'A 30-minute discussion of your goals, context and timelines — enough to see whether AI is the right lever and what a sensible first step looks like. No sales script, no obligation.' },
      { keys: ['training', 'literacy', 'workshop', 'enablement', 'upskill'],
        a: 'AI literacy and team enablement are part of the CoE work — roles, skills frameworks and literacy programmes. For a focused team workshop, raise it in the first conversation.' },
      { keys: ['data safe', 'my data', 'privacy policy', 'use my', 'share my'],
        a: 'Enquiries go to Parag directly and are used only to respond to you — no selling of data, no marketing lists. NDAs are welcome before anything sensitive is shared.' },
      { keys: ['speaking', 'speaker', 'keynote', 'advisory', 'board', 'event'],
        a: 'Yes — speaking, advisory and board-level AI guidance are all options. Choose \u201cSpeaking or advisory\u201d in the contact form, or mention it in your email to parag@kudtarkar.life.' },
      { keys: ['start', 'get started', 'getting started', 'first step', 'begin', 'engage', 'hire', 'work with you', 'work together'],
        a: 'Starting is simple: a confidential 30-minute discussion — tap "Book a meeting" or email parag@kudtarkar.life. No sales script, no obligation, and NDAs are welcome before anything sensitive is shared.' },
      { keys: ['remote', 'on site', 'onsite', 'in person', 'time zone', 'time zones', 'travel'],
        a: 'Both. Engagements run across regions and time zones — remotely, and on site where it matters. Delivery experience spans APAC, Europe and North America.' },
      { keys: ['build', 'implement', 'hands-on', 'handson', 'only advise', 'deliver the solution', 'who builds'],
        a: 'Both modes exist: the practice can advise and design, or lead delivery hands-on — strategy, governance, vendor selection, and production build oversight. The right mode depends on your team and context; we\u2019ll work it out in the first conversation.' },
      { keys: ['what does an ai consultancy', 'what do ai consultancies', 'ai consultancy do', 'what would a consultancy'],
        a: 'An AI consultancy helps organisations identify valuable AI opportunities, build the capability to deliver them, and put solutions into controlled production use.' },
      { keys: ['need an ai strategy', 'strategy before starting', 'before starting projects', 'strategy first'],
        a: 'Yes — a clear strategy connects AI investment to business priorities, defines the operating model, and prevents disconnected pilots from consuming budget without creating value.' },
      { keys: ['where ai will add value', 'where to use ai', 'where can ai help', 'decide where ai'],
        a: 'Yes. The work starts with business goals, workflows, data readiness, cost pressures, risks and customer needs to identify and prioritise viable opportunities.' },
      { keys: ['all business problems', 'every problem', 'problems require ai', 'always ai'],
        a: 'No. Some problems are better addressed through process improvement, workflow redesign, data quality work or standard software. The right intervention matters more than applying AI everywhere.' },
      { keys: ['centralised ai team', 'central team', 'centralised team', 'federated'],
        a: 'Not necessarily. Many organisations benefit from a federated model: shared specialist expertise and governance, combined with business-unit ownership of priorities, adoption and outcomes.' },
      { keys: ['from scratch', 'establish an ai centre', 'set up a coe', 'stand up a coe', 'build a coe'],
        a: 'Yes. That can include the mandate, sponsorship model, operating structure, roles, intake process, governance, skills framework, platform foundations and delivery roadmap.' },
      { keys: ['prioritise ai use cases', 'prioritise use cases', 'how do you prioritise', 'which use case first'],
        a: 'Opportunities are assessed against business value, feasibility, data readiness, integration needs, regulatory exposure, delivery complexity, total cost of ownership and adoption potential.' },
      { keys: ['pilot and production', 'pilot vs production', 'pilot versus production', 'difference between a pilot'],
        a: 'A pilot tests whether an idea has potential. Production AI requires secure integration, defined ownership, monitoring, evaluation, governance, support processes and evidence of value over time.' },
      { keys: ['existing pilots', 'move pilots', 'pilots into production', 'stuck in pilot', 'pilot purgatory'],
        a: 'Yes. The focus is on identifying what is missing: data and architecture foundations, security, model evaluation, workflow integration, governance, operating ownership or a sustainable funding model.' },
      { keys: ['measure value', 'measure roi', 'measuring success', 'how do you measure', 'value from ai'],
        a: 'Measures are defined before delivery and may include revenue, cost-to-serve, productivity, quality, speed, risk reduction, customer experience, clinical outcomes or employee adoption.' },
      { keys: ['responsible ai in practice', 'responsible ai mean', 'what is responsible ai'],
        a: 'Responsible AI means putting governance, security, privacy, human oversight, evaluation, auditability and monitoring into the delivery lifecycle rather than treating them as a final compliance exercise.' },
      { keys: ['regulated industries', 'regulated sector', 'heavily regulated', 'can ai be used in regulated'],
        a: 'Yes, provided the use case, data, controls, accountability and deployment model are appropriate for the regulatory environment and risk profile.' },
      { keys: ['which frameworks', 'which governance', 'relevant frameworks', 'what frameworks'],
        a: 'The appropriate framework depends on the organisation and jurisdiction. Relevant areas may include NIST AI RMF, ISO 42001, the EU AI Act, GDPR, PDPA, HIPAA, FDA SaMD and financial-services guidance such as MAS TRM and FEAT.' },
      { keys: ['data privacy and security', 'privacy and security', 'how do you address data'],
        a: 'The approach covers data classification, access controls, model and prompt handling, secure integration, privacy-by-design, supplier due diligence, threat assessment and monitoring after release.' },
      { keys: ['sovereign ai', 'sovereignty', 'data residency', 'hosted where'],
        a: 'Yes. Sovereign AI considerations include where data, models and workloads are hosted; who controls them; applicable jurisdictions; security requirements; and the level of independence required from external providers.' },
      { keys: ['own ai platform', 'build our own platform', 'do we need a platform'],
        a: 'Usually not from the outset. The right decision depends on strategic needs, data sensitivity, integration requirements, capability maturity, commercial constraints and the platforms already in place.' },
      { keys: ['existing technology partners', 'existing partners', 'our vendors', 'current suppliers', 'work with our'],
        a: 'Yes. Effective transformation often requires alignment across internal teams, specialist vendors, cloud providers, systems integrators and strategic partners.' },
      { keys: ['clinical ai', 'medical device', 'medical-device', 'medtech innovation', 'clinical workflows'],
        a: 'Yes. Relevant work includes clinical AI, remote monitoring, computer vision, wearable and IoT solutions, regulated delivery and integration with clinical workflows.' },
      { keys: ['financial-services', 'financial services ai', 'banking', 'wealth ai', 'fsi'],
        a: 'Yes. This includes AI strategy, operating-model design, AI portfolio planning, governance, knowledge and document intelligence, advisor support and controlled deployment in regulated environments.' },
      { keys: ['smaller businesses engage', 'can smaller', 'small business engage', 'smes engage'],
        a: 'Yes. Smaller organisations can begin with a focused AI readiness review, workflow assessment or a well-scoped opportunity that establishes value before larger investment.' },
      { keys: ['typical engagement', 'what does an engagement', 'engagement look like', 'what does a typical'],
        a: 'Engagements may range from an executive strategy workshop or AI readiness assessment to CoE design, portfolio prioritisation, governance design, product innovation or delivery leadership.' },
      { keys: ['how long does an ai strategy', 'strategy engagement take', 'strategy take'],
        a: 'The duration depends on organisational scale, stakeholder availability, existing capability and the number of opportunities under review. A focused assessment can begin quickly; enterprise operating-model work requires deeper engagement.' },
      { keys: ['implementation support', 'implementation', 'help implement'],
        a: 'Yes. Support can extend from strategy and architecture through to prototype design, supplier alignment, programme leadership, production delivery and outcome measurement.' },
      { keys: ['replace internal teams', 'replace our team', 'replace internal'],
        a: 'No. The aim is to strengthen internal capability, establish clear ownership and help teams make better decisions, deliver effectively and sustain outcomes after the engagement.' },
      { keys: ['what should we prepare', 'before an initial conversation', 'prepare before', 'what do we need to prepare'],
        a: 'A clear problem statement is useful, but not required. It helps to know the strategic objective, major workflow or customer challenge, relevant stakeholders, available data, constraints and decision timeline.' },
      { keys: ['crm', 'integration', 'api', 'webhook'],
        a: 'Technical integrations are very much part of the work — though chat-based ones are beyond me for now. Email parag@kudtarkar.life or book a meeting and describe what you have in mind.' }
    ];

    /* Semantic FAQ retrieval (TF-IDF/BM25 over the FAQ corpus) — used to ground
       the LLM with the closest FAQ entries and to answer verbatim in lite mode.
       Loaded from js/semantic-faq.js; degrades gracefully if missing. */
    var Sem = (typeof SemanticFAQ !== 'undefined') ? SemanticFAQ
            : (typeof require === 'function' ? (function () { try { return require('./semantic-faq.js').SemanticFAQ; } catch (e) { return null; } })() : null);
    var faqMatcher = null;
    if (Sem && Sem.build) {
      faqMatcher = Sem.build(ANSWERS.map(function (item) {
        return { q: (item.keys || []).join(' '), a: item.a, keys: item.keys };
      }));
    }



    function answer(text) {
      var t = ' ' + (text || '').toLowerCase() + ' ';
      var best = null, bestScore = 0;
      ANSWERS.forEach(function (item) {
        var score = 0;
        item.keys.forEach(function (k) { if (t.indexOf(k) !== -1) score += k.length; });
        if (score > bestScore) { bestScore = score; best = item; }
      });
      return best ? best.a : null;
    }

    /* ---------- exports ---------- */

    function leadSnapshot() {
      return { name: lead.name, email: lead.email, phone: lead.phone, topic: lead.topic };
    }

    return {
      observe: observe,
      wantsBooking: wantsBooking,
      isActive: isActive,
      missingSlot: missingSlot,
      state: function () { return fsm.state; },
      startBooking: startBooking,
      turn: turn,
      resetFlow: resetFlow,
      resumeGreeting: resumeGreeting,
      templatedFree: templatedFree,
      answer: answer,
      answerSemantic: function (text) {
        if (!faqMatcher) return null;
        var hit = faqMatcher.best(text, 3.5);
        return hit ? hit.entry.a : null;
      },
      answersCount: ANSWERS.length,
      guardReply: guardReply,
      safeReply: SAFE_REPLY,
      parseToolCall: parseToolCall,
      executeTool: executeTool,
      topicsFor: topicsFor,
      buildSystemPrompt: buildSystemPrompt,
      lead: leadSnapshot
    };
  }

  var AIAgent = {
    createAgent: createAgent,
    CORE_PROMPT: CORE_PROMPT,
    FACT_BLOCKS: FACT_BLOCKS,
    SUMMARY_LINE: SUMMARY_LINE,
    UNSAFE_PATTERNS: UNSAFE_PATTERNS
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = AIAgent;
  root.AIAgent = AIAgent;
})(typeof window !== 'undefined' ? window : globalThis);
