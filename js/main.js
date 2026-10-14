/*
 * AI-PtP site script.
 * Sections: nav, year, contact form, Calendly iframe + booking popup,
 * wordmark animation, scroll reveals, and the agent-driven chat assistant.
 * The assistant's brain (booking FSM, lead store, guard, tools) lives in js/agent.js.
 */
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
      window.location.href = 'mailto:parag@kudtarkar.life' +
        '?subject=' + encodeURIComponent(subject) +
        '&body=' + encodeURIComponent(body);
    });
  }

  /* ---------- Agent core (booking FSM, lead store, guard, tools) ---------- */

  var agent = window.AIAgent ? window.AIAgent.createAgent() : null;

  var calHost = window.location.hostname || 'localhost';

  function calendlyUrl(eventSlug) {
    var lead = agent ? agent.lead() : { name: '', email: '' };
    var params = [
      'embed_domain=' + encodeURIComponent(calHost),
      'embed_type=Inline',
      'hide_gdpr_banner=1',
      'background_color=0C211A',
      'text_color=F4F1E8',
      'primary_color=A9C23F'
    ];
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

  function openCalendlyPopup(url) {
    ensureCalendlyScript();
    if (window.Calendly && window.Calendly.initPopupWidget) {
      window.Calendly.initPopupWidget({ url: url });
      return;
    }
    var tries = 0;
    var timer = setInterval(function () {
      tries++;
      if (window.Calendly && window.Calendly.initPopupWidget) {
        clearInterval(timer);
        window.Calendly.initPopupWidget({ url: url });
      } else if (calendlyState === 'failed' || tries > 16) {
        clearInterval(timer);
        window.open(url, '_blank', 'noopener');
      }
    }, 250);
  }

  var calFrame = document.getElementById('calendly-frame');
  if (calFrame && !calFrame.getAttribute('src')) {
    calFrame.src = calendlyUrl('30min');
  }

  document.querySelectorAll('.book-option').forEach(function (btn) {
    btn.addEventListener('click', function () {
      openCalendlyPopup(calendlyUrl(btn.getAttribute('data-event') || '30min'));
    });
  });

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

  var MODEL_ID = 'Llama-3.2-1B-Instruct-q4f16_1-MLC';

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
    var history = [];
    var webgpuOk = typeof navigator !== 'undefined' && !!navigator.gpu;

    function setStatus(text) { chatEls.status.textContent = text; }

    function setBusy(busy) {
      chatEls.input.disabled = busy || !engine;
      chatEls.send.disabled = busy || !engine;
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

    function attachBookingCta(bubble) {
      if (!bubble || bubble.querySelector('.chat-cta')) return;
      var cta = document.createElement('button');
      cta.className = 'chat-cta';
      cta.type = 'button';
      cta.textContent = 'Book a meeting';
      cta.addEventListener('click', function () {
        openCalendlyPopup(calendlyUrl('30min'));
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
        setStatus('Unavailable');
        chatEls.unsupported.hidden = false;
        return;
      }
      if (!engine && !loadingStarted) startLoading();
      else if (engine) chatEls.input.focus();
    });

    chatEls.close.addEventListener('click', closePanel);

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !panel.hidden) closePanel();
    });

    async function startLoading() {
      if (engine || loadingStarted) return;
      loadingStarted = true;
      chatEls.progress.hidden = false;
      setStatus('Loading\u2026');
      try {
        var webllm = await import('https://esm.run/@mlc-ai/web-llm');
        engine = await webllm.CreateMLCEngine(MODEL_ID, {
          initProgressCallback: function (r) {
            chatEls.progress.textContent = 'Loading the assistant\u2026 ' + Math.round((r.progress || 0) * 100) + '%';
          }
        });
        history = [{ role: 'system', content: agent.buildSystemPrompt('') }];
        setStatus('Ready');
        chatEls.progress.hidden = true;
        setBusy(false);
        chatEls.input.focus();
        var greeting = agent.resumeGreeting() ||
          'Hi there! \uD83D\uDC4B I\u2019m the AI-PtP Assistant \u2014 I can chat about the services here or help you book a meeting. What\u2019s on your mind?';
        addMsg('bot', greeting);
      } catch (err) {
        setStatus('Failed to load');
        chatEls.progress.textContent = 'Loading failed: ' + (err && err.message ? err.message : 'unknown error');
        addMsg('bot', 'Hmm, I couldn\u2019t load this time \u2014 likely a network hiccup. No worries: you can email parag@kudtarkar.life or book a meeting, and I\u2019ll be here next time.');
        loadingStarted = false;
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
      if (!text || !engine || generating) return;
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
        if (fsmOut.openCal) openCalendlyPopup(calendlyUrl('30min'));
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
            openCalendlyPopup(calendlyUrl('30min'));
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

        if (/book a meeting|booking|calendar/i.test(reply)) attachBookingCta(bubble);
      } catch (err) {
        bubble.textContent = 'Ah, something glitched on my end just now. Mind trying again \u2014 or easier, book a meeting / drop an email and we\u2019ll talk properly?';
      }
      generating = false;
      setBusy(false);
      chatEls.input.focus();
    });

    /* Preload the Calendly widget so popups open instantly on user gesture. */
    if (webgpuOk) ensureCalendlyScript();
  }
})();
