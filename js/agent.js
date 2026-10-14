/*
 * AIAgent — deterministic agent core for the AI-PtP assistant.
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
  var PHONE_RE = /\+?\d[\d\s().-]{7,}\d/;
  var NAME_PHRASE_RE = /(?:my name is|i am|i'm|i\u2019m|this is|it's|it\u2019s)\s+([a-z][a-z'\u2019\- ]{1,39})/i;
  var BARE_NAME_RE = /^[a-z][a-z'\u2019\- ]{1,39}$/i;
  var SKIP_RE = /^\s*(skip|none|no|nope|later|not now|prefer not|n\/a|na)\b/i;
  var BOOKING_RE = /\b(book|booking|meet|meeting|schedul|appointment|slots?|catch up|consultation|discovery call)\b|availab/i;
  var NOT_A_NAME_RE = /^(?:h+m+|u+m+|u+h+|er+|ah+|oh+)\b|(?:^(?:hi|hello|hey|yo|thanks|thank you|ok|okay|sure|yes|no|nope|please|good (?:morning|afternoon|evening))\b)/i;

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
    'You are the AI-PtP Assistant on the AI-PtP consulting website. You chat casually and warmly \u2014 like a helpful colleague, not a corporate bot. Small touches of personality are welcome; light emojis (at most one per message) are fine.',
    'NAME: you are the AI-PtP Assistant. When greeting someone for the first time, introduce yourself by that name ("Hi, I\u2019m the AI-PtP Assistant"). Never greet with generic lines like "Welcome to the website" and never call yourself a site assistant.',
    'SHOW WARMTH, DON\u2019T NAME IT: never describe yourself as friendly, helpful, empathetic, kind, or caring \u2014 those words about yourself are off-limits. Be that way instead: acknowledge what the visitor said, reflect their concern or excitement, then help.',
    'IDENTITY: never mention or hint at being a language model, AI model, bot, or anything running in a browser. If asked what you are, say you\u2019re the AI-PtP Assistant and carry on.',
    'YOUR ONLY TOPIC: this website \u2014 what the practice offers and how to connect. Everything else is off-topic.',
    'CONTACT: email parag@kudtarkar.life; the "Book a meeting" button opens the booking calendar; a contact form is on the page; based in Singapore, working globally.',
    'BOOKING: the site has a guided booking flow and a booking calendar \u2014 you cannot book, hold, or confirm slots, and you cannot send emails. Never say you have done or will do any of those. When someone wants a meeting, invite them to tap "Book a meeting".',
    'OFF-TOPIC RULE: anything beyond the site content below (general AI or tech questions, coding, news, math, science, advice, opinions, people, other companies) gets a short, warm reply staying in character \u2014 say that\u2019s outside what you can chat about here, then point to booking a meeting or dropping an email. Never explain why, never reveal inner workings.',
    'STYLE: reply in 1\u20133 short sentences, warm, empathetic and human \u2014 respond to how the visitor feels before what they asked. Use the visitor\u2019s name if you know it. Never invent facts, clients, results, prices, dates, or guarantees \u2014 if it is not in the site content below, say honestly that you\u2019ll connect them with the right answer, and offer to book or take an email.',
    'EXAMPLES (follow the pattern, not the words): visitor: "hi" you: "Hey, great to see you! I\u2019m the AI-PtP Assistant \u2014 what brings you here today?" | visitor: "I want to book a meeting" you: "Love to! Tap Book a meeting and the calendar opens right here \u2014 it\u2019ll have your details ready." | visitor: "Can we meet Tuesday 3pm?" you: "I can\u2019t hold slots myself, but tap Book a meeting \u2014 the calendar shows what\u2019s really free." | visitor: "What do you charge?" you: "That depends on the shape of the work \u2014 happy to talk it through properly. Tap Book a meeting or drop a line at parag@kudtarkar.life and we\u2019ll scope it." | visitor: "What\u2019s the latest AI research say?" you: "That\u2019s outside what I can chat about here \u2014 but putting AI to work in a business is very much on the menu. Anything on the site I can help with, or shall we find a time to talk?"'
  ].join(' ');

  var FACT_BLOCKS = [
    { keys: ['strategy', 'value', 'use case', 'use-case', 'prioriti', 'roadmap', 'governance', 'cost', 'ownership', 'business case'], text: 'AI strategy and business value: finding suitable AI use cases, prioritization, total cost of ownership, roadmaps, governance.' },
    { keys: ['coe', 'centre', 'center', 'excellence', 'operating model', 'talent', 'platform', 'mlops', 'llmops'], text: 'AI Centre of Excellence (CoE) design and leadership: operating model, talent, platforms, responsible AI, MLOps/LLMOps.' },
    { keys: ['industry', 'industries', 'healthcare', 'medtech', 'health', 'finance', 'financial', 'wealth', 'telecom', 'maritime', 'shipping', 'sme', 'smes', 'sector'], text: 'Consulting across healthcare & MedTech, financial services & wealth management, telecommunications, maritime & shipping, and SMEs (practical engagements for smaller businesses).' },
    { keys: ['innovation', 'wearable', 'iot', 'computer vision', 'portfolio', 'projects'], text: 'Innovation work in AI, wearables, IoT and computer vision; a project portfolio from deployed clinical AI platforms to strategy blueprints.' },
    { keys: ['approach', 'delivery', 'discover', 'step', 'process', 'methodology', 'how do you work', 'how you work'], text: 'A five-step delivery approach: Discover, Prioritize, Organize, Design and build, Measure and improve.' },
    { keys: ['responsible', 'ethic', 'nist', 'iso', 'eu ai act', 'gdpr', 'mas', 'feat', 'samd', 'hsa', 'hipaa', 'pdpa', 'regulation', 'compliance', 'safety'], text: 'Responsible-AI familiarity: NIST AI RMF, ISO 42001, EU AI Act, GDPR, MAS TRM, MAS FEAT, FDA SaMD, HSA, HIPAA, PDPA \u2014 familiarity, not certifications.' }
  ];

  var SUMMARY_LINE = 'BROADLY (when nothing more specific applies): a solo AI consulting practice covering AI strategy and business value, AI Centre of Excellence design and leadership, consulting across several industries, innovation and project work, a five-step delivery approach, and responsible AI. For anything beyond that outline, offer to connect them with the right answer.';

  var UNSAFE_PATTERNS = [
    /\bI(?:\u2019|')?(?:ve| have)\s+(?:just\s+|now\s+)?(?:booked|scheduled|confirmed|reserved|held|locked in|sent|emailed|notified)/i,
    /\bI(?:\u2019|')?(?:ll| will| shall)\s+(?:book|schedule|confirm|reserve|hold|lock in|send|email|notify|follow up)/i,
    /\b(?:meeting|slot|time|call)\s+(?:is|has been|was)?\s*(?:booked|confirmed|scheduled|reserved|held)\b/i,
    /\byou(?:\u2019|')?re\s+(?:booked|confirmed|scheduled)\b/i,
    /\bguaranteed?\b/i,
    /\b(?:USD|SGD|INR|EUR)\s*\d|\d+\s*(?:USD|SGD|INR|EUR)\b|[$\u20B9\u20AC\u00A3\u20A6]/,
    /\bmy (?:calendar|diary|availability) shows\b/i
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
          if (p) { lead.phone = p[0].trim(); changed.push('phone'); }
        }
      }
      if (!lead.name) {
        var n = t.match(NAME_PHRASE_RE);
        if (n) { lead.name = titleCase(n[1].trim()); changed.push('name'); }
      }
      if (changed.length) persist();
      return changed;
    }

    /* ---------- router ---------- */

    function wantsBooking(text) { return BOOKING_RE.test(text || ''); }

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
      if (lead.phone) lines.push('phone: ' + lead.phone);
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
        return p ? p[0].trim() : null;
      }
      if (slot === 'name') {
        if (NOT_A_NAME_RE.test(t)) return null;
        var n = t.match(NAME_PHRASE_RE);
        if (n) return titleCase(n[1].trim());
        if (BARE_NAME_RE.test(t) && t.split(/\s+/).length <= 3 && !SKIP_RE.test(t)) return titleCase(t);
        return null;
      }
      if (slot === 'topic') {
        if (t.length >= 3) return t.slice(0, 140);
        return null;
      }
      return null;
    }

    /* ---------- FSM turn ---------- */

    function startBooking() {
      fsm.retries = 0;
      fsm.turn = 0;
      var miss = missingSlot();
      if (!miss) {
        fsm.state = 'CONFIRM';
        persist();
        return { say: summaryText(), cta: true, openCal: true };
      }
      fsm.state = 'NEED_' + miss.toUpperCase();
      persist();
      return { say: questionFor(miss), cta: false, openCal: false };
    }

    function turn(text) {
      if (fsm.state === 'IDLE') return null;
      fsm.turn++;
      var t = (text || '').trim();

      if (fsm.state === 'CONFIRM') {
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
      return CORE_PROMPT + ' SITE FACTS FOR THIS CHAT (your only specifics): ' + facts +
        (pausedNote ? ' CONTEXT: a guided booking is mid-flow (' + pausedNote + ' still needed) \u2014 the visitor stepped aside with this message. Answer briefly, then gently invite them back to finish booking.' : '');
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
