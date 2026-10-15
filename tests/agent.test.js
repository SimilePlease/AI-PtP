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

/* ---------- router + passive capture ---------- */

check('booking intent detected', function () {
  var a = fresh();
  assert.ok(a.wantsBooking("I'd like to book a meeting"));
  assert.ok(a.wantsBooking('do you have availability next week?'));
  assert.ok(!a.wantsBooking('what is a CoE?'));
});

check('passive capture: phrase name, email, phone and topic from free text', function () {
  var a = fresh();
  a.observe('My name is Priya');
  assert.strictEqual(a.lead().name, 'Priya');
  var changed = a.observe('my email is priya@example.com and my number is +65 9123 4567');
  assert.strictEqual(a.lead().email, 'priya@example.com', JSON.stringify(a.lead()));
  assert.strictEqual(a.lead().phone, '+65 9123 4567');
  a.observe('I need help taking our AI pilots to production in a regulated bank');
  assert.strictEqual(a.lead().topic, 'I need help taking our AI pilots to production in a regulated bank');
  assert.ok(changed.indexOf('topic') !== -1 || a.lead().topic.length > 0);
});

check('passive capture: bare names and small talk are never stored as data', function () {
  var a = fresh();
  ['hello', 'Sam Ostagawa', 'yes', 'thanks'].forEach(function (t) { a.observe(t); });
  assert.strictEqual(a.lead().name, '', 'bare/greeting text must not become a name');
  var b = fresh();
  b.observe("i'm wei-ling");
  assert.strictEqual(b.lead().name, 'Wei-ling');
});

check('save_lead tool stores bare details the LLM captured in conversation', function () {
  var a = fresh();
  assert.ok(a.executeTool({ tool: 'save_lead', args: { field: 'name', value: 'Sam Ostagawa' } }).ok);
  assert.strictEqual(a.lead().name, 'Sam Ostagawa');
  assert.ok(a.executeTool({ tool: 'save_lead', args: { field: 'phone', value: 'skip' } }).ok);
  assert.strictEqual(a.lead().phone, '(skipped)');
});

check('lead persists across agent instances (same store); fresh store greets nobody', function () {
  var store = memoryStore();
  var a1 = AIAgent.createAgent(store);
  a1.observe('my name is Arjun, email arjun@corp.example');
  var a2 = AIAgent.createAgent(store);
  assert.strictEqual(a2.lead().name, 'Arjun');
  assert.strictEqual(a2.lead().email, 'arjun@corp.example');
  assert.ok(/Welcome back, Arjun/.test(a2.resumeGreeting()));
  assert.strictEqual(fresh().resumeGreeting(), null); // nothing to resume
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
