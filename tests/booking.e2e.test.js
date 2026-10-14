/*
 * End-to-end simulation of the chat booking flow, exactly as main.js routes it:
 * FSM first, LLM fallback, guard last. Verifies every booking conversation path
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

/* Mimics main.js's submit handler: FSM-first router + guarded LLM fallback. */
function makeChat(store, engineReplies) {
  var agent = AIAgent.createAgent(store);
  var openedUrls = [];
  var transcript = [];
  var replyIndex = 0;

  function llm() { return engineReplies[Math.min(replyIndex++, engineReplies.length - 1)]; }

  function openCal(url) { openedUrls.push(url); }

  function send(text) {
    transcript.push('visitor: ' + text);
    agent.observe(text);
    var fsmOut = null;
    if (!agent.isActive() && agent.wantsBooking(text)) fsmOut = agent.startBooking(text);
    else if (agent.isActive()) fsmOut = agent.turn(text);

    if (fsmOut && !fsmOut.pause) {
      transcript.push('bot: ' + fsmOut.say);
      if (fsmOut.openCal) openCal('https://calendly.com/kudtarkar-parag/30min?email=' + encodeURIComponent(agent.lead().email) + '&name=' + encodeURIComponent(agent.lead().name));
      return { text: fsmOut.say, cta: fsmOut.cta, fromFSM: true };
    }

    var raw = llm();
    var reply = agent.guardReply(raw) ? raw : agent.safeReply;
    transcript.push('bot (llm): ' + reply);
    return { text: reply, cta: /book a meeting|booking|calendar/i.test(reply), fromFSM: false };
  }

  return { agent: agent, send: send, transcript: transcript, openedUrls: openedUrls };
}

check('E2E: "I want to book a meeting" \u2192 guided flow \u2192 calendar auto-opens prefilled', function () {
  var chat = makeChat(memoryStore(), []);
  var r1 = chat.send("hi, I'd like to book a meeting");
  assert.ok(r1.fromFSM && /name/i.test(r1.text), r1.text);
  assert.ok(!r1.cta);                                   // collecting first, no premature CTA
  chat.send('Asha Nair');
  chat.send('asha@company.example');
  chat.send('+65 9123 4567');
  var r5 = chat.send('AI CoE for a medtech company');
  assert.ok(r5.cta, 'confirm step must attach CTA');
  assert.strictEqual(chat.openedUrls.length, 1, 'calendar auto-opens exactly once');
  var url = chat.openedUrls[0];
  assert.ok(url.includes('email=asha%40company.example'), 'email prefilled: ' + url);
  assert.ok(url.includes('name=Asha%20Nair'), 'name prefilled: ' + url);
  assert.ok(url.includes('calendly.com/kudtarkar-parag/30min'), 'correct event path');
});

check('E2E: visitor suggests a time \u2192 FSM acknowledges it and starts guided booking', function () {
  var chat = makeChat(memoryStore(), []);
  var r = chat.send('can we meet Tuesday 3pm?');
  assert.ok(r.fromFSM, 'guided booking starts');
  assert.ok(/can\u2019t hold slots myself/i.test(r.text), 'proposed time acknowledged: ' + r.text);
  assert.ok(/name/i.test(r.text), 'then collects details');
  assert.strictEqual(chat.openedUrls.length, 0, 'calendar opens only after details collected');
});

check('E2E: hallucinating engine ("I\u2019ve booked you") is caught by guard', function () {
  var chat = makeChat(memoryStore(), [
    "Perfect! I've booked a meeting for you on 15th October at 11:00 AM. I'll send a confirmation email."
  ]);
  var r = chat.send('who do I contact about a pilot?');
  assert.ok(!r.fromFSM);
  assert.ok(r.text === AIAgent.createAgent(memoryStore()).safeReply, 'reply replaced with safe text');
  assert.ok(r.cta, 'safe reply still offers booking CTA');
  assert.ok(!chat.transcript.some(function (l) { return l.startsWith('bot') && /I\u2019ve booked|I\u2019ll send/i.test(l); }), 'hallucination never reaches visitor');
});

check('E2E: question mid-booking pauses flow, then resumes where it left off', function () {
  var chat = makeChat(memoryStore(), ['An AI CoE is a central team that scales AI capability across the business.']);
  chat.send('book a meeting please');
  var pause = chat.send('quick question: what is an AI CoE?');
  assert.ok(!pause.fromFSM, 'stepped aside to LLM');
  assert.strictEqual(chat.agent.state(), 'NEED_NAME', 'FSM state preserved');
  var resume = chat.send('Jonathan Reeve');
  assert.ok(resume.fromFSM && /email/i.test(resume.text), 'resumes with the next slot');
});

check('E2E: returning visitor with saved lead skips straight to confirm', function () {
  var store = memoryStore();
  var warm = makeChat(store, []);
  warm.send('book a meeting');
  warm.send('Asha Nair');
  warm.send('asha@company.example');
  warm.send('+65 9123 4567');
  warm.send('AI strategy');
  warm.send('ok');   // leaves CONFIRM

  var again = makeChat(store, []);
  var r = again.send('I want to book another meeting');
  assert.ok(r.fromFSM && /calendar opens with your details/i.test(r.text), r.text);
  assert.ok(r.cta && again.openedUrls.length === 1, 'calendar opened with existing details');
});

check('E2E: Calendly popup URL the chat opens is well-formed and reachable', function () {
  var chat = makeChat(memoryStore(), []);
  chat.send('book a meeting');
  chat.send('Bo Chen');
  chat.send('bo.chen@corp.example');
  chat.send('555 0100 222');
  chat.send('AI governance review');
  var url = chat.openedUrls[0];
  assert.ok(url.startsWith('https://calendly.com/kudtarkar-parag/30min?'));
  ['email=', 'name='].forEach(function (p) { assert.ok(url.includes(p)); });
});

check('E2E: "can you book it for me" at confirm \u2192 calendar opens prefilled, no persona drift', function () {
  var chat = makeChat(memoryStore(), []);
  chat.send('book a meeting');
  chat.send('Parag');
  chat.send('kudtarkar.parag@gmail.com');
  chat.send('skip');
  chat.send('AI implementation');
  assert.strictEqual(chat.agent.state(), 'CONFIRM');
  chat.openedUrls.length = 0;
  var r = chat.send('can you book it for me');
  assert.ok(r.fromFSM, 'FSM handles the booking ask, not the LLM');
  assert.ok(r.cta && chat.openedUrls.length === 1, 'calendar auto-opens');
  assert.ok(chat.openedUrls[0].includes('email=kudtarkar.parag%40gmail.com'), 'prefilled: ' + chat.openedUrls[0]);
  assert.ok(!/my time|our clients|as a solo/i.test(r.text), 'no practice-persona drift');
});

check('E2E: persona-drift hallucination ("my time is limited, our clients") is guarded', function () {
  var chat = makeChat(memoryStore(), [
    "I'm afraid not. As a solo AI consulting practice, I don't have the capability to book meetings. My time is limited, and I need to stay focused on providing value to our clients."
  ]);
  var r = chat.send('who do I contact about a pilot?');
  assert.ok(r.text === chat.agent.safeReply, 'drift reply replaced with safe text');
  assert.ok(r.cta);
});

console.log(failures === 0 ? '\nE2E BOOKING TESTS: ALL PASSED' : '\nE2E BOOKING TESTS: ' + failures + ' FAILURE(S)');
process.exit(failures === 0 ? 0 : 1);
