/*
 * Unit tests for the AIAgent core (no DOM, no framework).
 * Run: node tests/agent.test.js
 */
'use strict';

require('../js/agent.js');
var AIAgent = globalThis.AIAgent;
var assert = require('assert');

function memoryStore() {
  var map = {};
  return {
    getItem: function (k) { return k in map ? map[k] : null; },
    setItem: function (k, v) { map[k] = String(v); },
    removeItem: function (k) { delete map[k]; }
  };
}

function fresh() { return AIAgent.createAgent(memoryStore()); }

var failures = 0;
function check(name, fn) {
  try { fn(); console.log('  ok  ' + name); }
  catch (e) { failures++; console.log('FAIL  ' + name + ' \u2014 ' + e.message); }
}

/* ---------- router + FSM happy path ---------- */

check('booking intent detected', function () {
  var a = fresh();
  assert.ok(a.wantsBooking("I'd like to book a meeting"));
  assert.ok(a.wantsBooking('do you have availability next week?'));
  assert.ok(!a.wantsBooking('what is a CoE?'));
});

check('full FSM happy path: name \u2192 email \u2192 skip phone \u2192 topic \u2192 confirm + openCal', function () {
  var a = fresh();
  assert.strictEqual(a.state(), 'IDLE');
  var s = a.startBooking();
  assert.strictEqual(a.state(), 'NEED_NAME');
  assert.ok(/name/i.test(s.say));

  s = a.turn('My name is Priya');
  assert.strictEqual(a.state(), 'NEED_EMAIL', s.say);
  assert.ok(a.lead().name === 'Priya', JSON.stringify(a.lead()));

  s = a.turn('priya@example.com');
  assert.strictEqual(a.state(), 'NEED_PHONE', s.say);

  s = a.turn('skip');
  assert.strictEqual(a.state(), 'NEED_TOPIC', s.say);
  assert.strictEqual(a.lead().phone, '(skipped)');

  s = a.turn('AI CoE for a regulated bank');
  assert.strictEqual(a.state(), 'CONFIRM', s.say);
  assert.ok(s.cta && s.openCal);
  assert.ok(s.say.indexOf('Priya') !== -1 && s.say.indexOf('priya@example.com') !== -1);
});

check('bare name accepted; phrase name title-cased', function () {
  var a = fresh();
  a.startBooking();
  a.turn('Sam Ostagawa');
  assert.strictEqual(a.lead().name, 'Sam Ostagawa');
  var b = fresh();
  b.startBooking();
  b.turn("i'm wei-ling");
  assert.strictEqual(b.lead().name, 'Wei-ling');
});

check('greeting words are not captured as names', function () {
  var a = fresh();
  a.startBooking();
  a.turn('hello');
  assert.strictEqual(a.state(), 'NEED_NAME');
  assert.strictEqual(a.lead().name, '');
});

check('invalid input twice falls back gracefully with CTA and exits flow', function () {
  var a = fresh();
  a.startBooking();
  a.turn('hello');          // not a name \u2192 re-ask
  assert.strictEqual(a.state(), 'NEED_NAME');
  var out = a.turn('hmm');  // second failure \u2192 fallback
  assert.strictEqual(a.state(), 'IDLE');
  assert.ok(out.cta);
  assert.strictEqual(a.lead().name, ''); // nothing wrong saved
});

check('real question mid-flow pauses FSM and keeps state', function () {
  var a = fresh();
  a.startBooking();
  var out = a.turn('Actually, what does an AI CoE include?');
  assert.ok(out && out.pause);
  assert.strictEqual(a.state(), 'NEED_NAME');
});

check('CONFIRM turns into free chat afterwards', function () {
  var a = fresh();
  a.startBooking();
  ['Ada Lovelace', 'ada@example.com', '+65 9000 0001', 'AI strategy'].forEach(function (t) { a.turn(t); });
  assert.strictEqual(a.state(), 'CONFIRM');
  var out = a.turn('thanks!');
  assert.ok(out && out.pause);
  assert.strictEqual(a.state(), 'IDLE');
  assert.strictEqual(a.lead().email, 'ada@example.com'); // lead kept
});

check('FSM persists across agent instances (same store) and resumes', function () {
  var store = memoryStore();
  var a1 = AIAgent.createAgent(store);
  a1.startBooking();
  a1.turn('my name is Arjun');
  a1.turn('arjun@corp.example');
  var a2 = AIAgent.createAgent(store);
  assert.strictEqual(a2.state(), 'NEED_PHONE');
  assert.strictEqual(a2.lead().email, 'arjun@corp.example');
  var out = a2.turn('+65 9123 4567');
  assert.strictEqual(a2.state(), 'NEED_TOPIC');
  assert.strictEqual(a2.lead().phone, '+65 9123 4567');
});

check('resumeGreeting welcomes back mid-flow and after lead captured', function () {
  var store = memoryStore();
  var a1 = AIAgent.createAgent(store);
  a1.startBooking();
  a1.turn('my name is Mei');
  var a2 = AIAgent.createAgent(store);
  assert.ok(/finish/i.test(a2.resumeGreeting()));
  var store2 = memoryStore();
  var c1 = AIAgent.createAgent(store2);
  c1.observe('I am Tobias, tobias@example.com');
  var c2 = AIAgent.createAgent(store2);
  assert.ok(/Welcome back, Tobias/.test(c2.resumeGreeting()));
  var d = fresh();
  assert.strictEqual(d.resumeGreeting(), null); // nothing to resume
});

/* ---------- observe (free-text capture) ---------- */

check('observe extracts email, phone, name from free text', function () {
  var a = fresh();
  var changed = a.observe('hey I\u2019m Nadia, ping me at nadia@x.io or +65 9888 0001');
  assert.ok(changed.indexOf('email') !== -1 && changed.indexOf('phone') !== -1 && changed.indexOf('name') !== -1);
  assert.strictEqual(a.lead().email, 'nadia@x.io');
});

/* ---------- guard ---------- */

check('guard blocks unsafe claims and passes warm honest replies', function () {
  var a = fresh();
  var blocked = [
    "I've booked a meeting for you on 15th October at 11:00 AM.",
    'I\u2019ll send you a confirmation email.',
    'Your meeting is confirmed for Tuesday.',
    'I can guarantee results.',
    'It costs around $5000.'
  ];
  blocked.forEach(function (t) { assert.ok(!a.guardReply(t), 'should block: ' + t); });
  var allowed = [
    'I can\u2019t book or confirm slots myself \u2014 tap Book a meeting for real availability.',
    'Great to hear from you! Shall we find a time?'
  ];
  allowed.forEach(function (t) { assert.ok(a.guardReply(t), 'should pass: ' + t); });
});

/* ---------- identity / naming ---------- */

check('prompt names the assistant and forbids generic greetings', function () {
  var a = fresh();
  var p = a.buildSystemPrompt('hi');
  assert.ok(p.indexOf('Orbit') !== -1);
  assert.ok(p.indexOf('Welcome to the website') !== -1); // named as a forbidden pattern
  assert.ok(p.indexOf('Never greet') !== -1);
});

/* ---------- tool loop skeleton ---------- */

check('parseToolCall finds valid JSON tool calls, rejects prose/invalid', function () {
  var a = fresh();
  assert.deepStrictEqual(a.parseToolCall('{"tool":"open_booking","args":{}}'), { tool: 'open_booking', args: {} });
  assert.deepStrictEqual(a.parseToolCall('Sure! {"tool":"save_lead","args":{"field":"email","value":"a@b.co"}} thanks'),
    { tool: 'save_lead', args: { field: 'email', value: 'a@b.co' } });
  assert.strictEqual(a.parseToolCall('just plain text'), null);
  assert.strictEqual(a.parseToolCall('{"broken":'), null);
});

check('executeTool: save_lead validates, open_booking flags action, unknown rejected', function () {
  var a = fresh();
  assert.ok(a.executeTool({ tool: 'save_lead', args: { field: 'email', value: 'x@y.co' } }).ok);
  assert.strictEqual(a.lead().email, 'x@y.co');
  assert.ok(!a.executeTool({ tool: 'save_lead', args: { field: 'email', value: 'not-an-email' } }).ok);
  assert.ok(!a.executeTool({ tool: 'save_lead', args: { field: 'hacker', value: 'x' } }).ok);
  assert.strictEqual(a.executeTool({ tool: 'open_booking', args: {} }).action, 'open_booking');
  assert.ok(!a.executeTool({ tool: 'rm_rf', args: {} }).ok);
  assert.ok(a.executeTool({ tool: 'get_lead', args: {} }).data);
});

/* ---------- prompt building ---------- */

check('buildSystemPrompt injects matched facts and remembers topics', function () {
  var a = fresh();
  var p = a.buildSystemPrompt('tell me about responsible AI compliance');
  assert.ok(p.indexOf('NIST AI RMF') !== -1);
  var p2 = a.buildSystemPrompt('something else entirely');
  assert.ok(p2.indexOf('BROADLY') !== -1 || p2.indexOf('NIST AI RMF') !== -1); // prior topics retained
});

console.log(failures === 0 ? '\nALL TESTS PASSED' : '\n' + failures + ' TEST(S) FAILED');
process.exit(failures === 0 ? 0 : 1);
