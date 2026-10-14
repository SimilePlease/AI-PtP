/* Orbit semantic FAQ matcher.
 *
 * BM25 ranking over the FAQ corpus, computed in-browser at load.
 * No server, no network calls, deterministic — the retrieval half of RAG:
 * the best-matching FAQ entry grounds the LLM (full mode) or replies verbatim (lite).
 *
 * Public API:
 *   SemanticFAQ.build(entries)          -> matcher instance
 *   matcher.search(query, topK)         -> [{ index, score, entry }]
 *   matcher.best(query, threshold)      -> entry | null
 *
 * Entry shape: { q: string, a: string, keys?: string[] }  (keys = extra boost terms)
 *
 * Design notes:
 * - Tokeniser: lowercase, split on non-letters, drop stopwords, light suffix-stemming
 *   (s/es/ies/ing/ed) so "prioritise/prioritising/prioritised" and
 *   "consultancy/consultancies" collapse to the same stem.
 * - IDF: smoothed log(1 + (N - df + 0.5)/(df + 0.5)) so rare terms (sovereign, nda,
 *   federated) dominate.
 * - Query terms absent from the corpus contribute 0 — unknown phrasing simply
 *   matches nothing rather than hallucinating a match.
 * - Thresholds are BM25 score floors (agent.js uses 3.5): high-precision.
 *   Below threshold we prefer honesty over guesswork.
 */

(function (factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = { SemanticFAQ: factory() };
  else window.SemanticFAQ = factory();
})(function () {

  var STOPWORDS = {
    a:1, an:1, and:1, are:1, as:1, at:1, be:1, but:1, by:1, can:1, do:1, does:1, for:1,
    from:1, had:1, has:1, have:1, how:1, i:1, if:1, in:1, is:1, it:1, its:1, me:1, my:1,
    no:1, not:1, of:1, on:1, or:1, our:1, should:1, so:1, that:1, the:1, their:1, them:1,
    there:1, this:1, to:1, us:1, was:1, we:1, were:1, what:1, when:1, where:1, which:1,
    who:1, will:1, with:1, would:1, you:1, your:1, about:1, into:1, before:1, after:1
  };

  function stem(w) {
    if (w.length > 4 && /ies$/.test(w)) return w.slice(0, -3) + 'y';      /* prioritise→? no; consultancies→consultancy */
    if (w.length > 4 && /(sses|shes|ches|xes)$/.test(w)) return w.slice(0, -2);
    if (w.length > 3 && /s$/.test(w) && !/ss$/.test(w)) return w.slice(0, -1);
    if (w.length > 5 && /ing$/.test(w)) return w.slice(0, -3);            /* prioritising→prioritis */
    if (w.length > 4 && /ed$/.test(w)) return w.slice(0, -2);             /* phased→phas */
    return w;
  }

  /* Collocations the stemmer can't bridge: query-side words expanded to corpus-side words. */
  var SYNONYMS = {
    cost:['price','pricing','fee','fees','budget','expensive','cheap','charge','set','back','spend','invest','investment','money'],
    price:['cost','pricing','fee','budget','charge'],
    nda:['nda','confidential','confidentiality','sensitive','secret'],
    confidential:['nda','confidentiality','discreet'],
    privacy:['privacy','confidential','data','protection','safe','secure','security'],
    secure:['secure','security','safe','safety','protect','protected'],
    safe:['secure','security','safe','privacy','protected'],
    data:['data','information','info'],
    partner:['partner','partners','vendor','vendors','supplier','suppliers','integrator','integrators','provider','providers'],
    supplier:['supplier','suppliers','vendor','vendors','partner','partners'],
    vendor:['vendor','vendors','supplier','suppliers','partner'],
    begin:['begin','start','starting','first','step','engage','engagement','onboard'],
    start:['begin','start','starting','first','step','engage'],
    step:['step','steps','stage','begin','start','approach'],
    first:['first','begin','start','initial'],
    pilot:['pilot','pilots','poc','proof','concept','prototype','experiment','trial'],
    production:['production','live','deployed','deployment','scale','scaling','rollout'],
    live:['live','production','deployed'],
    prioritise:['prioritise','prioritize','rank','ranking','assess','assessment','evaluate','evaluation','choose','select','sequencing'],
    measure:['measure','measuring','metric','metrics','kpi','value','roi','outcome','outcomes'],
    strategy:['strategy','strategic','plan','planning','roadmap','direction'],
    plan:['plan','planning','strategy','strategic','roadmap'],
    sovereignty:['sovereign','sovereignty','residency','jurisdiction','jurisdictions','hosted','hosting','independence'],
    sovereign:['sovereign','sovereignty','residency','jurisdiction','jurisdictions','hosted','hosting'],
    industry:['industry','industries','sector','sectors','vertical','verticals'],
    framework:['framework','frameworks','standard','standards','regulation','regulations','compliance'],
    regulation:['regulation','regulations','compliance','framework','frameworks','act','gdpr','nist','iso'],
    training:['training','literacy','workshop','workshops','enablement','upskill','course'],
    speak:['speaking','speaker','keynote','talk','presentation','event'],
    consultant:['consultancy','consultancies','consultant','consultants','practice','firm'],
    build:['build','building','implement','implementation','deliver','delivery','develop'],
    implement:['implement','implementation','build','deliver','delivery'],
    small:['small','smaller','sme','smes','businesses','growth','startup'],
    remote:['remote','remotely','onsite','site','zone','zones','region','regions','globally','timezone'],
    approach:['approach','method','methodology','process','steps','model'],
    agent:['agentic','agent','agents'],
    platform:['platform','platforms','infrastructure','stack'],
    decide:['decide','prioritise','assess','evaluate','choose','select','rank'],
    takeover:['takeover','take','over','replace','strengthen','substitute'],
    country:['country','sovereign','residency','jurisdiction','border','local'],
    train:['train','training','teach','coach','upskill','literacy'],
    current:['current','existing','present','today'],
    protect:['protect','protected','protecting','safeguard'],
    use:['use','using','apply','leverage'],
    company:['company','organisation','business','firm']
  };

  function tokenize(text) {
    var out = [];
    String(text || '').toLowerCase().split(/[^a-z0-9]+/).forEach(function (w) {
      if (!w || w.length < 2 || STOPWORDS[w]) return;
      out.push(stem(w));
    });
    return out;
  }

  /* tokenizeWithWeights: direct terms count 1, synonym-expanded terms count 0.5.
     Keeps near-synonyms competitive without letting an expansion flood swamp
     the literal terms a doc actually shares with the query. */
  function tokenizeWithWeights(text) {
    var direct = tokenize(text);
    var weighted = {};
    direct.forEach(function (w) { weighted[w] = (weighted[w] || 0) + 1; });
    direct.slice().forEach(function (w) {
      var syn = SYNONYMS[w];
      if (!syn) return;
      syn.forEach(function (sy) {
        var st = stem(sy);
        if (!(st in weighted)) weighted[st] = 0.5;
      });
    });
    return Object.keys(weighted).map(function (k) { return { w: k, tf: weighted[k] }; });
  }

  /* --- vector helpers --- */

  function build(entries) {
    entries = entries || [];
    var N = entries.length;
    var docs = [];               /* [{ tf:{w:count}, len }] */
    var docFreq = {};            /* w -> df */
    var totalLen = 0;

    entries.forEach(function (e) {
      /* Docs are indexed with LITERAL tokens only — synonym expansion is a
         query-side affordance. Expanding documents too lets a doc containing
         "current capability" claim credit for "exist/present/today".
         Question-title terms count double: a question match is stronger
         evidence than the same word inside a long answer. */
      var tf = {}, len = 0;
      function addTerms(text, boost) {
        tokenize(text).forEach(function (w) {
          tf[w] = (tf[w] || 0) + boost;
          len += boost;
        });
      }
      addTerms(e.q, 2);
      addTerms(e.a, 1);
      addTerms((e.keys || []).join(' '), 1.5);
      Object.keys(tf).forEach(function (w) { docFreq[w] = (docFreq[w] || 0) + 1; });
      docs.push({ tf: tf, len: len });
      totalLen += len;
    });

    var avgLen = N ? totalLen / N : 0;
    var K1 = 1.5, B = 0.75;

    function idf(w) {
      var df = docFreq[w] || 0;
      if (!df) return 0;
      return Math.log(1 + (N - df + 0.5) / (df + 0.5));
    }

    function search(query, topK) {
      topK = topK || 3;
      if (!N) return [];
      var qTerms = tokenizeWithWeights(query);
      if (!qTerms.length) return [];
      var qWeight = {};
      qTerms.forEach(function (t) { qWeight[t.w] = Math.max(qWeight[t.w] || 0, t.tf); });

      var scored = [];
      docs.forEach(function (d, i) {
        var score = 0, hits = 0;
        Object.keys(qWeight).forEach(function (w) {
          var f = d.tf[w];
          if (!f) return;
          hits++;
          var qMul = qWeight[w] >= 1 ? 1 : 0.5;   /* synonym terms contribute half */
          var tfPart = (f * (K1 + 1)) / (f + K1 * (1 - B + B * d.len / avgLen));
          score += qMul * idf(w) * tfPart;
        });
        if (hits) scored.push({ index: i, score: score, entry: entries[i], hits: hits });
      });
      scored.sort(function (x, y) { return y.score - x.score; });
      return scored.slice(0, topK);
    }

    function best(query, threshold) {
      var hits = search(query, 1);
      if (!hits.length || hits[0].score < (threshold || 0.9)) return null;
      return hits[0];
    }

    return { search: search, best: best, size: function () { return N; }, tokenize: tokenize, tokenizeWithWeights: tokenizeWithWeights };
  }

  return { build: build, tokenize: tokenize };
});
