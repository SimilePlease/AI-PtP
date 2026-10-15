/*
 * End-to-end simulation of the chat booking flow, exactly as main.js routes it
 * (stateless — no guided FSM): lite-mode hand-off, LLM + open_booking tool,
 * passive lead capture, guard last. Verifies every booking conversation path
 * and the Calendly URLs the chat would open (prefill included).
 * Run: node tests/booking.e2e.test.js
 */
'use strict';

require('../js/agent.js');
var AIAgent = globalThis.AIAgent;
var assert = require('assert');

function memoryStore() {
  var map = {};
  return { getItem: function (k) { return k in map ? map[k] : null; }, setItem: function (k, v) { map[k] = String(v); } };
}

var failures = 0;
function check(name, fn) {
  try { fn(); console.log('  ok  ' + name); }
  catch (e) { failures++; console.log('FAIL  ' + name + ' \u2014 ' + e.message); }
}

/* Mimics main.js's submit handler: stateless router — lite hand-off or LLM with
   tools, guard last. engineReplies === [] simulates lite mode (no model). */
function makeChat(store, engineReplies) {
  var agent = AIAgent.createAgent(store);
  var openedUrls = [];
  var submittedLeads = [];
  var transcript = [];
  var replyIndex = 0;

  function llm() { return engineReplies[Math.min(replyIndex++, engineReplies.length - 1)]; }

  function openCal(url) { openedUrls.push(url); }
  function prefill() {
    var l = agent.lead();
    return 'https://calendly.com/kudtarkar-parag/30min?email=' + encodeURIComponent(l.email) + '&name=' + encodeURIComponent(l.name);
  }

  function send(text) {
    transcript.push('visitor: ' + text);
    var changed = agent.observe(text);
    if (changed.indexOf('email') !== -1) submittedLeads.push(agent.lead());

    /* Lite mode: booking intent \u2192 honest hand-off, calendar opens now. */
    if (!engineReplies.length && agent.wantsBooking(text)) {
      transcript.push('bot: (lite booking hand-off)');
      openCal(prefill());
      submittedLeads.push(agent.lead());
      return { text: 'book a meeting calendar', cta: true, lite: true };
    }

    /* LLM path, including the tool loop (open_booking opens the calendar). */
    var reply = llm();
    var call = agent.parseToolCall(reply);
    if (call && call.tool === 'open_booking') {
      openCal(prefill());
      submittedLeads.push(agent.lead());
      reply = 'The calendar is open \u2014 pick whatever suits you.';
    }
    if (!agent.guardReply(reply)) reply = agent.safeReply;
    transcript.push('bot (llm): ' + reply);
    return { text: reply, cta: /book a meeting|booking|calendar/i.test(reply), lite: false };
  }

  return { agent: agent, send: send, transcript: transcript, openedUrls: openedUrls, submittedLeads: submittedLeads };
}

check('E2E lite mode: "I want to book a meeting" \u2192 hand-off, calendar auto-opens, lead ships', function () {
  var chat = makeChat(memoryStore(), []);
  var r = chat.send("hi, I'd like to book a meeting");
  assert.ok(r.lite && r.cta, 'deterministic hand-off with CTA');
  assert.strictEqual(chat.openedUrls.length, 1, 'calendar auto-opens exactly once');
  assert.ok(chat.openedUrls[0].includes('calendly.com/kudtarkar-parag/30min'), 'correct event path');
  assert.strictEqual(chat.submittedLeads.length, 1, 'lead submitted on booking');
});

check('E2E LLM mode: booking intent \u2192 Orbit converses, open_booking tool opens calendar', function () {
  var chat = makeChat(memoryStore(), [
    'Love to! One moment \u2014 opening the calendar for you now. {"tool":"open_booking","args":{}}'
  ]);
  var r = chat.send('could we set up a meeting next week?');
  assert.ok(!r.lite, 'handled by the LLM, not a canned flow');
  assert.strictEqual(chat.openedUrls.length, 1, 'tool opened the calendar');
  assert.ok(/calendar is open/i.test(r.text), 'tool message shown: ' + r.text);
  assert.ok(r.cta);
});

check('E2E: details shared in passing are captured passively and prefill the calendar', function () {
  var chat = makeChat(memoryStore(), [
    'Pleasure to meet you, Asha! What would you like to explore?',
    'Happy to help \u2014 {"tool":"open_booking","args":{}}'
  ]);
  chat.send('hey, I\u2019m Asha Nair, asha@company.example, +65 9123 4567');
  chat.send('could we set up a call?');
  assert.strictEqual(chat.submittedLeads.length, 2, 'lead ships on email capture + booking');
  var url = chat.openedUrls[0];
  assert.ok(url.includes('email=asha%40company.example'), 'email prefilled: ' + url);
  assert.ok(url.includes('name=Asha%20Nair'), 'name prefilled: ' + url);
  assert.ok(chat.agent.lead().phone === '+65 9123 4567', 'phone captured for the CRM');
});

check('E2E: visitor suggests a time \u2192 LLM acknowledges honestly (no slot-holding)', function () {
  var chat = makeChat(memoryStore(), [
    'I can\u2019t hold slots myself, but the calendar is opening now \u2014 Tuesday 3pm shows as really free. {"tool":"open_booking","args":{}}'
  ]);
  var r = chat.send('can we meet Tuesday 3pm?');
  assert.strictEqual(chat.openedUrls.length, 1, 'calendar opens so they can take the slot');
  assert.ok(!/booked|confirmed|reserved/i.test(r.text), 'no fake confirmation: ' + r.text);
});

check('E2E: hallucinating engine ("I\u2019ve booked you") is caught by guard', function () {
  var chat = makeChat(memoryStore(), [
    "Perfect! I've booked a meeting for you on 15th October at 11:00 AM. I'll send a confirmation email."
  ]);
  var r = chat.send('who do I contact about a pilot?');
  assert.ok(r.text === AIAgent.createAgent(memoryStore()).safeReply, 'reply replaced with safe text');
  assert.ok(r.cta, 'safe reply still offers booking CTA');
  assert.ok(!chat.transcript.some(function (l) { return l.startsWith('bot') && /I\u2019ve booked|I\u2019ll send/i.test(l); }), 'hallucination never reaches visitor');
});

check('E2E: Calendly popup URL the chat opens is well-formed', function () {
  var chat = makeChat(memoryStore(), []);
  chat.send('book a meeting');
  var url = chat.openedUrls[0];
  assert.ok(url.startsWith('https://calendly.com/kudtarkar-parag/30min?'));
  ['email=', 'name='].forEach(function (p) { assert.ok(url.includes(p)); });
});

check('E2E: returning visitor with a saved lead gets welcomed back', function () {
  var store = memoryStore();
  var warm = makeChat(store, []);
  warm.send('hey, I\u2019m Tobias, tobias@example.com');

  var again = makeChat(store, []);
  assert.ok(/Welcome back, Tobias/.test(again.agent.resumeGreeting()), 'name remembered');
  var r = again.send('I want to book another meeting');
  assert.ok(r.lite && r.cta && again.openedUrls.length === 1, 'calendar opens with existing details');
  var url = again.openedUrls[0];
  assert.ok(url.includes('email=tobias%40example.com'), 'prefilled from saved lead: ' + url);
});

check('E2E: persona-drift hallucination ("my time is limited, our clients") is guarded', function () {
  var chat = makeChat(memoryStore(), [
    "I'm afraid not. As a solo AI consulting practice, I don't have the capability to book meetings. My time is limited, and I need to stay focused on providing value to our clients."
  ]);
  var r = chat.send('who do I contact about a pilot?');
  assert.ok(r.text === chat.agent.safeReply, 'drift reply replaced with safe text');
  assert.ok(r.cta);
});

check('E2E: fresh "hi" \u2192 hallucinated "You mentioned you want to book" is guarded', function () {
  var chat = makeChat(memoryStore(), [
    "You're here, and I'm glad to see you're excited to connect with me. You mentioned you want to book a meeting, so tap \"Book a meeting\" and we'll get started."
  ]);
  var r = chat.send('hi');
  assert.ok(!r.lite, 'free chat for a greeting');
  assert.ok(r.text === chat.agent.safeReply, 'false-attribution reply replaced');
  assert.ok(r.cta, 'CTA still offered');
});

check('E2E: conversation about a topic never captures bogus lead data', function () {
  var chat = makeChat(memoryStore(), [
    'An AI CoE is a central team that scales AI capability across the business. Want the deep dive?'
  ]);
  chat.send('quick question: what is an AI CoE?');
  var l = chat.agent.lead();
  assert.strictEqual(l.email, '');
  assert.strictEqual(l.name, '');
  assert.ok(/AI CoE/i.test(l.topic), 'interest captured for the CRM: ' + l.topic);
});

console.log(failures === 0 ? '\nE2E BOOKING TESTS: ALL PASSED' : '\nE2E BOOKING TESTS: ' + failures + ' FAILURE(S)');
process.exit(failures === 0 ? 0 : 1);
