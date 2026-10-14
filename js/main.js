(function () {
  'use strict';

  var header = document.querySelector('.site-header');
  var toggle = document.querySelector('.nav-toggle');

  function closeNav() {
    if (!header) return;
    header.setAttribute('data-nav-open', 'false');
    if (toggle) toggle.setAttribute('aria-expanded', 'false');
  }

  if (header && toggle) {
    toggle.addEventListener('click', function () {
      var open = header.getAttribute('data-nav-open') === 'true';
      header.setAttribute('data-nav-open', open ? 'false' : 'true');
      toggle.setAttribute('aria-expanded', open ? 'false' : 'true');
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeNav();
    });

    document.querySelectorAll('.site-nav a').forEach(function (link) {
      link.addEventListener('click', closeNav);
    });
  }

  var year = document.getElementById('year');
  if (year) year.textContent = String(new Date().getFullYear());

  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  var form = document.getElementById('contact-form');
  if (form) {
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var name = (form.elements.name.value || '').trim();
      var email = (form.elements.email.value || '').trim();
      var topic = form.elements.topic.value || '';
      var message = (form.elements.message.value || '').trim();
      var subject = 'Website enquiry: ' + topic + (name ? ' — ' + name : '');
      var body = 'Name: ' + name + '\nEmail: ' + email + '\nTopic: ' + topic + '\n\n' + message + '\n';
      postHubSpot({ name: name, email: email, phone: '', topic: topic }, 'contact form').catch(function () {
        window.location.href = 'mailto:parag@kudtarkar.life' +
          '?subject=' + encodeURIComponent(subject) +
          '&body=' + encodeURIComponent(body);
      });
      window.location.href = 'mailto:parag@kudtarkar.life' +
        '?subject=' + encodeURIComponent(subject) +
        '&body=' + encodeURIComponent(body);
    });
  }

  /* ---------- Agent core (booking FSM, lead store, guard, tools) ---------- */

  var agent = window.AIAgent ? window.AIAgent.createAgent() : null;

  var calHost = window.location.hostname || 'localhost';

  /* ---------- HubSpot CRM (live) + optional Apps Script email drafts ---------- */
  var HS_PORTAL = '247689473';
  var HS_FORM = '5e367cdc-1882-4693-ba29-cd5787601626';
  var CRM_ENDPOINT = '';   // Apps Script /exec URL — enables AI email drafts when set
  var CRM_TOKEN = '';      // shared secret configured in Apps Script
  var leadQueue = [];
  try { leadQueue = JSON.parse(localStorage.getItem('aiptp-lead-queue-v1') || '[]'); } catch (e) { leadQueue = []; }

  function hubspotPayload(lead, source) {
    var parts = (lead.name || '').split(/\s+/);
    var fields = [
      { name: 'firstname', value: parts[0] || '' },
      { name: 'lastname', value: parts.slice(1).join(' ') || '(chat)' },
      { name: 'email', value: lead.email },
      { name: 'message', value: (lead.topic || 'Chat enquiry') + ' [via ' + source + (lead.phone && lead.phone !== '(skipped)' ? ' · phone: ' + lead.phone : ' · phone: not provided') + ']' }
    ];
    if (lead.phone && lead.phone !== '(skipped)') fields.splice(3, 0, { name: 'phone', value: lead.phone });
    return { fields: fields, context: { pageName: 'AI-PtP ' + source } };
  }

  function postHubSpot(lead, source) {
    return fetch('https://api.hsforms.com/submissions/v3/integration/submit/' + HS_PORTAL + '/' + HS_FORM, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(hubspotPayload(lead, source))
    }).then(function (r) {
      if (!r.ok) throw new Error('HubSpot HTTP ' + r.status);
      return true;
    });
  }

  function queueFlush() {
    if (!leadQueue.length) return;
    var batch = leadQueue.splice(0, leadQueue.length);
    batch.forEach(function (item) {
      postHubSpot(item.lead, item.source).catch(function () { leadQueue.push(item); });
      if (CRM_ENDPOINT) {
        fetch(CRM_ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: JSON.stringify({ token: CRM_TOKEN, name: item.lead.name, email: item.lead.email, phone: item.lead.phone, topic: item.lead.topic, source: item.source })
        }).catch(function () { /* CRM optional; contact already stored */ });
      }
    });
    try { localStorage.setItem('aiptp-lead-queue-v1', JSON.stringify(leadQueue)); } catch (e) { /* private mode */ }
  }

  function submitLead(source) {
    if (!agent) return;
    var lead = agent.lead();
    if (!lead.email) return;                       // nothing to submit without an email
    var last = leadQueue.length && leadQueue[leadQueue.length - 1];
    if (last && last.lead.email === lead.email && last.lead.name === lead.name) return; // no duplicate spam
    leadQueue.push({ lead: { name: lead.name, email: lead.email, phone: lead.phone, topic: lead.topic }, source: source });
    try { localStorage.setItem('aiptp-lead-queue-v1', JSON.stringify(leadQueue)); } catch (e) { /* private mode */ }
    queueFlush();
  }

  window.addEventListener('online', queueFlush);

  function calendlyUrl(eventSlug, forPopup) {
    var lead = agent ? agent.lead() : { name: '', email: '' };
    var params = [
      'hide_gdpr_banner=1',
      'background_color=0C211A',
      'text_color=F4F1E8',
      'primary_color=A9C23F'
    ];
    if (!forPopup) {
      params.unshift('embed_domain=' + encodeURIComponent(calHost));
      params.splice(1, 0, 'embed_type=Inline');
    }
    if (lead.email) params.push('email=' + encodeURIComponent(lead.email));
    if (lead.name) params.push('name=' + encodeURIComponent(lead.name));
    return 'https://calendly.com/kudtarkar-parag/' + (eventSlug || '30min') + '?' + params.join('&');
  }

  var calendlyState = '';

  function ensureCalendlyScript() {
    if (calendlyState !== '') return;
    calendlyState = 'loading';
    var s = document.createElement('script');
    s.src = 'https://assets.calendly.com/assets/external/widget.js';
    s.async = true;
    s.onload = function () { calendlyState = 'ready'; };
    s.onerror = function () { calendlyState = 'failed'; };
    document.body.appendChild(s);
  }

  /* In-page Calendly modal when the script is ready; the poll is only for the
     auto-open path. Clicked CTAs are real <a> links, so they always work. */
  function openCalendlyPopup(url) {
    ensureCalendlyScript();
    if (calendlyState !== 'ready' || !(window.Calendly && window.Calendly.initPopupWidget)) return false;
    try {
      window.Calendly.initPopupWidget({ url: url });
    } catch (err) {
      calendlyState = 'failed';
      return false;
    }
    /* Verify the overlay really rendered; a silent no-op must never dead-end a click. */
    setTimeout(function () {
      var overlay = document.querySelector('.calendly-overlay, .calendly-popup, iframe[src*="calendly.com"]');
      if (!overlay) {
        calendlyState = 'failed';
        window.open(url, '_blank', 'noopener');
      }
    }, 600);
    return true;
  }

  var calFrame = document.getElementById('calendly-frame');
  if (calFrame && !calFrame.getAttribute('src')) {
    calFrame.src = calendlyUrl('30min', false);
  }

  /* Auto-open (no click gesture): wait for the script, then popup. */
  function autoOpenBooking() {
    var url = calendlyUrl('30min', true);
    ensureCalendlyScript();
    if (openCalendlyPopup(url)) return;
    var tries = 0;
    var timer = setInterval(function () {
      tries++;
      if (openCalendlyPopup(url)) {
        clearInterval(timer);
      } else if (calendlyState === 'failed' || tries > 16) {
        clearInterval(timer);
        window.open(url, '_blank', 'noopener');
      }
    }, 250);
  }

  /* Contact-section booking buttons: real links first, popup nicety second. */
  document.querySelectorAll('a.book-option').forEach(function (a) {
    a.setAttribute('href', calendlyUrl(a.getAttribute('data-event') || '30min'));
    a.setAttribute('target', '_blank');
    a.setAttribute('rel', 'noopener');
    a.addEventListener('click', function (e) {
      a.setAttribute('href', calendlyUrl(a.getAttribute('data-event') || '30min', true));
      if (openCalendlyPopup(a.href)) e.preventDefault();
    });
  });

  if (CRM_ENDPOINT) queueFlush();

  /* ---------- Wordmark animation ---------- */

  var wordmarks = document.querySelectorAll('.wordmark-anim');
  if (wordmarks.length && !reduceMotion) {
    var EXPAND_MS = 5200;
    var COLLAPSE_MS = 4600;
    var FADE_MS = 450;

    wordmarks.forEach(function (wm) {
      var label = wm.querySelector('.wordmark-text');
      if (!label) return;
      var shortText = wm.getAttribute('data-short') || 'AI-PtP';
      var fullText = wm.getAttribute('data-full') || shortText;

      function cycle() {
        wm.classList.remove('collapsing');
        label.textContent = fullText;
        wm.classList.add('expanded');

        setTimeout(function () {
          wm.classList.add('collapsing');
          setTimeout(function () {
            label.textContent = shortText;
            wm.classList.remove('expanded', 'collapsing');
          }, FADE_MS);
        }, COLLAPSE_MS);
      }

      setTimeout(cycle, 1600);
      setInterval(cycle, EXPAND_MS);
    });
  }

  /* ---------- Scroll reveals ---------- */

  if (!reduceMotion && 'IntersectionObserver' in window) {
    var targets = document.querySelectorAll('.section-head, .credential, .industry-card, .innovation-item, .use-case-card, .step, .case-group');
    if (targets.length) {
      targets.forEach(function (el) { el.classList.add('reveal'); });
      var observer = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            entry.target.classList.add('in');
            observer.unobserve(entry.target);
          }
        });
      }, { rootMargin: '0px 0px -8% 0px', threshold: 0.05 });
      targets.forEach(function (el) { observer.observe(el); });
    }
  }

  /* ---------- AI-PtP Assistant (agent-driven chat, WebLLM/WebGPU) ---------- */

  var MODEL_ID = 'Qwen2.5-0.5B-Instruct-q4f16_1-MLC';

  var fab = document.getElementById('chat-fab');
  var panel = document.getElementById('chat-panel');

  if (fab && panel && agent) {
    var chatEls = {
      status: document.getElementById('chat-status'),
      close: document.getElementById('chat-close'),
      msgs: document.getElementById('chat-msgs'),
      form: document.getElementById('chat-form'),
      input: document.getElementById('chat-text'),
      send: document.getElementById('chat-send'),
      progress: document.getElementById('chat-progress-text'),
      unsupported: document.getElementById('chat-unsupported')
    };

    var engine = null;
    var generating = false;
    var loadingStarted = false;
    var liteMode = false;
    var history = [];
    var webgpuOk = typeof navigator !== 'undefined' && !!navigator.gpu;

    function setStatus(text) { chatEls.status.textContent = text; }

    function setBusy(busy) {
      chatEls.input.disabled = busy || (!engine && !liteMode);
      chatEls.send.disabled = busy || (!engine && !liteMode);
    }

    function escapeHtml(s) {
      return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    function addMsg(role, text) {
      var b = document.createElement('div');
      b.className = 'chat-msg chat-msg--' + (role === 'user' ? 'user' : 'bot');
      if (role === 'user') {
        b.textContent = text;
      } else {
        b.innerHTML = escapeHtml(text).replace(
          /([\w.+-]+@[\w.-]+\.[a-z]{2,})/gi,
          '<a href="mailto:$1" style="color:var(--lime)">$1</a>'
        );
      }
      chatEls.msgs.appendChild(b);
      chatEls.msgs.scrollTop = chatEls.msgs.scrollHeight;
      return b;
    }

    /* Chat CTA is a real link: native new-tab navigation always works,
       with the in-page Calendly modal used when its script is ready. */
    function attachBookingCta(bubble) {
      if (!bubble || bubble.querySelector('.chat-cta')) return;
      var cta = document.createElement('a');
      cta.className = 'chat-cta';
      cta.href = calendlyUrl('30min');
      cta.target = '_blank';
      cta.rel = 'noopener';
      cta.textContent = 'Book a meeting';
      cta.addEventListener('click', function (e) {
        if (calendlyState === 'ready') cta.setAttribute('href', calendlyUrl('30min', true));
        if (openCalendlyPopup(cta.href)) e.preventDefault();
      });
      bubble.appendChild(cta);
      chatEls.msgs.scrollTop = chatEls.msgs.scrollHeight;
    }

    function closePanel() {
      panel.hidden = true;
      fab.setAttribute('aria-expanded', 'false');
      fab.focus();
    }

    fab.addEventListener('click', function () {
      var opening = panel.hidden;
      panel.hidden = !opening;
      fab.setAttribute('aria-expanded', opening ? 'true' : 'false');
      if (!opening) return;

      if (!webgpuOk) {
        liteMode = true;
        setStatus('Lite mode');
        chatEls.unsupported.hidden = true;
        chatEls.progress.hidden = true;
        history = [{ role: 'system', content: agent.buildSystemPrompt('') }];
        setBusy(false);
        chatEls.input.focus();
        addMsg('bot', 'Hi! \uD83D\uDC4B I\u2019m the AI-PtP Assistant, running in lite mode on this browser \u2014 happy to answer questions about the practice or help you book a meeting. What\u2019s on your mind?');
        return;
      }
      if (!engine && !loadingStarted) startLoading();
      else if (engine) chatEls.input.focus();
    });

    chatEls.close.addEventListener('click', closePanel);

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !panel.hidden) closePanel();
    });

    var pct = -1;

    function failLoad(reason) {
      liteMode = true;
      setStatus('Lite mode');
      chatEls.progress.hidden = false;
      chatEls.progress.textContent = reason;
      var bubble = addMsg('bot', 'The full brain didn\u2019t download on this network (it\u2019s ~300MB), so I\u2019m running in lite mode \u2014 quicker and simpler, but still useful. Ask me about the services, AI topics, or booking a meeting. Closing and reopening this chat retries the full download.');
      history = [{ role: 'system', content: agent.buildSystemPrompt('') }];
      setBusy(false);
      chatEls.input.focus();
      var g2 = agent.resumeGreeting() ||
        'Hi there! \uD83D\uDC4B I\u2019m the AI-PtP Assistant \u2014 I can chat about the services here or help you book a meeting. What\u2019s on your mind?';
      addMsg('bot', g2);
      history.push({ role: 'assistant', content: g2 });
      loadingStarted = false;
    }

    function withTimeout(promise, ms, label) {
      return Promise.race([
        promise,
        new Promise(function (_, reject) {
          setTimeout(function () { reject(new Error(label + ' timed out')); }, ms);
        })
      ]);
    }

    async function startLoading() {
      if (engine || loadingStarted) return;
      loadingStarted = true;
      chatEls.progress.hidden = false;
      setStatus('Loading\u2026');
      pct = 0;
      var lastMove = Date.now();
      /* Watchdog: if the percentage freezes for 30s (or all-up >3min), fail gracefully. */
      var watchdog = setInterval(function () {
        if (Date.now() - lastMove > 30000) {
          clearInterval(watchdog);
          if (!engine) { console.warn('[AI-PtP] model load stalled at ' + pct + '%'); failLoad('Stalled at ' + pct + '% \u2014 the model host may be blocked on this network.'); }
        }
      }, 3000);
      try {
        var webllm = await withTimeout(import('https://esm.run/@mlc-ai/web-llm'), 30000, 'Assistant download');
        try { caches.open('aiptp-webllm-v1').then(function (c) { c.add('https://esm.run/@mlc-ai/web-llm'); }); } catch (e) { /* best effort */ }
        engine = await webllm.CreateMLCEngine(MODEL_ID, {
          appConfig: webllm.prebuiltAppConfig,
          initProgressCallback: function (r) {
            var p = Math.round((r.progress || 0) * 100);
            if (p !== pct) { pct = p; lastMove = Date.now(); }
            chatEls.progress.textContent = 'Loading the assistant\u2026 ' + p + '%' + (p === 0 ? ' (first load is ~300MB)' : '');
            if (p === 0 && Date.now() - lastMove > 30000) lastMove = Date.now();
          }
        });
        clearInterval(watchdog);
        history = [{ role: 'system', content: agent.buildSystemPrompt('') }];
        setStatus('Ready');
        chatEls.progress.hidden = true;
        setBusy(false);
        chatEls.input.focus();
        var greeting = agent.resumeGreeting() ||
          'Hi there! \uD83D\uDC4B I\u2019m the AI-PtP Assistant \u2014 I can chat about the services here or help you book a meeting. What\u2019s on your mind?';
        addMsg('bot', greeting);
        history.push({ role: 'assistant', content: greeting });
      } catch (err) {
        clearInterval(watchdog);
        console.warn('[AI-PtP] load failed:', err);
        failLoad('Loading failed: ' + (err && err.message ? err.message : 'unknown error'));
      }
    }

    async function generateOnce() {
      var res = await engine.chat.completions.create({
        messages: history,
        temperature: 0.3,
        max_tokens: 300,
        stream: false
      });
      return (res.choices[0] && res.choices[0].message && res.choices[0].message.content) || '';
    }

    chatEls.form.addEventListener('submit', async function (e) {
      e.preventDefault();
      var text = chatEls.input.value.trim();
      if (!text || (!engine && !liteMode) || generating) return;
      chatEls.input.value = '';

      addMsg('user', text);
      agent.observe(text);
      history.push({ role: 'user', content: text });

      /* --- Router: deterministic booking FSM first --- */
      var fsmOut = null;
      if (!agent.isActive() && agent.wantsBooking(text)) {
        fsmOut = agent.startBooking(text);
      } else if (agent.isActive()) {
        fsmOut = agent.turn(text);
      }

      if (fsmOut && !fsmOut.pause) {
        var fsmBubble = addMsg('bot', fsmOut.say);
        history.push({ role: 'assistant', content: fsmOut.say });
        if (fsmOut.cta) attachBookingCta(fsmBubble);
        if (fsmOut.openCal) autoOpenBooking();
        submitLead('website chat');
        return;
      }

      /* --- Small talk: greetings/thanks/bye get deterministic replies --- */
      var canned = agent.templatedFree(text);
      if (canned) {
        var cannedBubble = addMsg('bot', canned);
        history.push({ role: 'assistant', content: canned });
        if (/book/i.test(canned)) attachBookingCta(cannedBubble);
        return;
      }

      /* --- Lite mode: curated answer engine, no model needed --- */
      if (!engine) {
        var lite = agent.answer(text);
        var liteText = lite || 'I want to give you a proper answer to that, and this isn\u2019t one I can do well in lite mode. Email parag@kudtarkar.life or book a meeting \u2014 you\u2019ll get a real one there.';
        var liteBubble = addMsg('bot', liteText);
        history.push({ role: 'assistant', content: liteText });
        if (/book/i.test(liteText)) attachBookingCta(liteBubble);
        return;
      }

      /* --- LLM path --- */
      generating = true;
      setBusy(true);
      var pausedNote = (fsmOut && fsmOut.pause && agent.missingSlot()) ? agent.missingSlot() : '';
      history[0] = { role: 'system', content: agent.buildSystemPrompt(text, pausedNote) };
      history = [history[0]].concat(history.slice(1).slice(-6));

      var bubble = addMsg('bot', '\u2026');
      try {
        var stream = await engine.chat.completions.create({
          messages: history,
          temperature: 0.3,
          max_tokens: 300,
          stream: true
        });
        var reply = '';
        for await (var chunk of stream) {
          reply += (chunk.choices[0] && chunk.choices[0].delta && chunk.choices[0].delta.content) || '';
          bubble.textContent = reply;
          chatEls.msgs.scrollTop = chatEls.msgs.scrollHeight;
        }

        /* --- Tool loop skeleton (max 3 iterations) --- */
        var iterations = 0;
        while (iterations < 3) {
          var call = agent.parseToolCall(reply);
          if (!call) break;
          var result = agent.executeTool(call);
          if (result && result.action === 'open_booking') {
            autoOpenBooking();
            reply = result.message || 'The calendar is open \u2014 pick whatever suits you.';
            bubble.textContent = reply;
            break;
          }
          history.push({ role: 'assistant', content: reply });
          history.push({
            role: 'user',
            content: 'TOOL ' + (result && result.ok ? 'RESULT: ' + JSON.stringify(result) : 'ERROR: ' + JSON.stringify(result)) +
              ' Now reply to the visitor in plain text only \u2014 1\u20133 short sentences, no JSON.'
          });
          reply = await generateOnce();
          bubble.textContent = reply;
          iterations++;
        }

        /* --- Guard: final output filter --- */
        if (!agent.guardReply(reply)) {
          reply = agent.safeReply;
          bubble.textContent = reply;
        }
        history.push({ role: 'assistant', content: reply });

        if (/book|booking|calendar|slot|schedul/i.test(reply)) attachBookingCta(bubble);
      } catch (err) {
        bubble.textContent = 'Ah, something glitched on my end just now. Mind trying again \u2014 or easier, book a meeting / drop an email and we\u2019ll talk properly?';
      }
      generating = false;
      setBusy(false);
      chatEls.input.focus();
    });

    /* Preload the Calendly widget so popups open instantly on user gesture. */
    ensureCalendlyScript();
  }
})();
