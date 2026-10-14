/* Semantic FAQ matcher — regression tests.
 * Corpus is parsed from content/faq.md so edits to the FAQ stay covered. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { SemanticFAQ } = require('../js/semantic-faq.js');
const AIAgent = require('../js/agent.js');

const md = fs.readFileSync(path.join(__dirname, '..', 'content', 'faq.md'), 'utf8');
const faq = [];
const re = /\*\*(Q\d*:? ?[^*]+?)\*\*\nA: ([^\n]+)/g; let m;
while ((m = re.exec(md))) faq.push({ q: m[1].replace(/^Q\d*:?\s*/, '').trim(), a: m[2].trim() });

var failures = 0;
function check(name, fn) {
  try { var ok = typeof fn === 'function' ? fn() : fn; if (ok === false) throw new Error('check returned false'); console.log('  ok  ' + name); }
  catch (e) { failures++; console.log('FAIL  ' + name + ' \u2014 ' + e.message); }
}

check('semantic: corpus parsed from faq.md has 45+ entries', faq.length >= 45);

const matcher = SemanticFAQ.build(faq);
check('semantic: matcher built for full corpus', matcher.size() === faq.length);

const paraphrases = [
  ['how much will it set me back', /shape|number|book|meeting/i],
  ['we need a plan before we spend on ai', /strategy|plan/i],
  ['our pilot never made it live', /pilot/i],
  ['is our data protected when we talk', /privacy|secur|confidential|safe/i],
  ['whats the first step to engage you', /begin|start|discussion|small/i],
  ['how do you decide what to build first', /priori|advise|hands-on|build|governance/i],
  ['what about keeping data in our own country', /sovereign|residency|jurisdiction|platform|hosted/i],
  ['will you train our people', /training|literacy|enablement|coe/i],
  ['can you take over from our internal team', /replace|strengthen/i],
  ['does this work for a small company', /small|sme|growth/i],
  ['how quickly can something start', /few weeks|longer|duration|begin|shape/i]
];
check('semantic: at least 10 of ' + paraphrases.length + ' paraphrases retrieve the right FAQ entry (matcher-only)', function () {
  var good = paraphrases.filter(function (t) {
    var hit = matcher.best(t[0], 0.9);
    return hit && t[1].test(hit.entry.q + ' ' + hit.entry.a);
  }).length;
  return good >= 10;
});
check('semantic: hybrid path (keyword + semantic) answers ALL paraphrases correctly', function () {
  var a = AIAgent.createAgent({ getItem: function () { return null; }, setItem: function () {}, removeItem: function () {} });
  return paraphrases.every(function (t) {
    var ans = a.answer(t[0]) || a.answerSemantic(t[0]);
    return ans && t[1].test(ans);
  });
});

check('semantic: out-of-domain queries are rejected (no false grounding)', function () {
  return ['best pizza near me', 'who won the world cup', 'tell me a joke', 'weather tomorrow']
    .every(function (q) { return !matcher.best(q, 0.9); });
});

check('semantic: lite path answers keyword-missed paraphrases', function () {
  var a = AIAgent.createAgent({ getItem: function () { return null; }, setItem: function () {}, removeItem: function () {} });
  return paraphrases.every(function (t) {
    var ans = a.answer(t[0]) || a.answerSemantic(t[0]);
    return !!ans;
  });
});

check('semantic: LLM prompt gains semantic facts for reworded questions', function () {
  var a = AIAgent.createAgent({ getItem: function () { return null; }, setItem: function () {}, removeItem: function () {} });
  var sys = a.buildSystemPrompt('can we keep our data in our own country');
  return /sovereign|hosted/i.test(sys);
});

check('semantic: booking guard-rails survive wiring', function () {
  var a = AIAgent.createAgent({ getItem: function () { return null; }, setItem: function () {}, removeItem: function () {} });
  return !/i will book/i.test(a.buildSystemPrompt(''));
});

console.log(failures === 0 ? '\nALL TESTS PASSED' : '\n' + failures + ' TEST(S) FAILED');
process.exit(failures === 0 ? 0 : 1);
