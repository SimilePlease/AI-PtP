/**
 * Email automation — Google Apps Script (free with any Gmail account).
 *
 * What it does (all free):
 *   POST { token, name, email, phone, topic, source, transcript? }   → chat/lead capture:
 *     1. Creates/updates the contact in HubSpot (keyless forms API)
 *     2. Asks Gemini (free API tier) to draft a personalized first-touch email
 *     3. Files it as a Gmail DRAFT for one-tap review & send
 *     4. Optional: scores the transcript with a self-hosted Kev decision
 *        model (sentiment, frustration, urgency, lead heat) — see README
 *
 *   POST { token, action:'cold', company, industry, contactName, notes }
 *                                                        → SME cold outreach:
 *     Gemini drafts the email; Gmail draft created (or sent if AUTO_SEND).
 *
 * Config (Script Settings / Script Properties):
 *   TOKEN        — shared secret; must match what the site sends
 *   PORTAL_ID    — HubSpot portal id
 *   FORM_GUID    — HubSpot form guid (fields: firstname, lastname, email, phone, message)
 *   GEMINI_KEY   — Google AI Studio API key (free tier)
 *   AUTO_SEND    — 'true' → send immediately; omit → drafts only (default, recommended)
 *   SENDER_NAME  — signature name, e.g. 'Parag — AI Pilot to Production'
 *   KEV_ENDPOINT — optional HTTPS base URL of your Kev decision-model
 *                  deployment (https://github.com/jaredpalmer/kev); enables
 *                  sentiment scoring of every chat lead
 *   KEV_MODEL    — optional model name, default 'kev-latest'
 *   KEV_API_KEY  — optional Bearer token if your Kev deployment enforces one
 *
 * Deploy: Deploy → New deployment → Web app → Execute as: Me → Access: Anyone.
 * Put the /exec URL + token into the site config (see README).
 */

var GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=';
var HUBSPOT_FORMS = 'https://api.hsforms.com/submissions/v3/integration/submit/';

function cfg(key) {
  return PropertiesService.getScriptProperties().getProperty(key) || '';
}

/* ---------------- entry ---------------- */

function doPost(e) {
  var out = { ok: false };
  try {
    var body = JSON.parse(e.postData.contents || '{}');
    if (!body.token || body.token !== cfg('TOKEN')) {
      out.error = 'unauthorized';
      return json(out);
    }
    var mode = String(body.action || 'lead');
    if (mode === 'cold') out = handleCold(body);
    else out = handleLead(body);
  } catch (err) {
    out = { ok: false, error: String(err) };
  }
  return json(out);
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/* ---------------- lead sentiment (Kev decision model, optional) ---------------- */

/* Ask a self-hosted Kev endpoint (https://github.com/jaredpalmer/kev) to score
   the conversation: overall sentiment, frustration, urgency and lead heat —
   all as calibrated probabilities, System One API. Returns null whenever
   KEV_ENDPOINT is unset or anything fails: sentiment must never break a lead. */
function kevSentiment(text) {
  var endpoint = cfg('KEV_ENDPOINT');
  var body = String(text || '').trim();
  if (!endpoint || !body) return null;
  try {
    var payload = {
      model: cfg('KEV_MODEL') || 'kev-latest',
      state: body.slice(-6000),
      questions: {
        sentiment:  { type: 'choice',
                      instructions: 'Overall sentiment of the prospective client across this conversation with the assistant of an AI consultancy.',
                      criteria: { positive: 'Engaged, hopeful, wants to move forward',
                                  neutral:  'Factual, curious, no strong emotion',
                                  negative: 'Skeptical, annoyed, unhappy or dismissive' } },
        frustrated: { type: 'noul', instructions: 'Is the visitor frustrated, upset or impatient at any point?' },
        urgent:     { type: 'noul', instructions: 'Does the visitor express urgency, a deadline or time pressure?' },
        heat:       { type: 'score',
                      instructions: 'How warm is this lead — how likely to book a call and become a client?',
                      criteria: ['cold', 'warm', 'hot'] }
      }
    };
    var headers = { 'Authorization': 'Bearer ' + cfg('KEV_API_KEY') };
    if (!cfg('KEV_API_KEY')) delete headers['Authorization'];
    var resp = UrlFetchApp.fetch(endpoint.replace(/\/+$/, '') + '/v1/systemone', {
      method: 'post',
      contentType: 'application/json',
      headers: headers,
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
    if (resp.getResponseCode() >= 300) return null;
    var data = JSON.parse(resp.getContentText());
    var a = (data && data.answers) || {};
    var s = a.sentiment || {}, f = a.frustrated || {}, u = a.urgent || {}, h = a.heat || {};
    var parts = [];
    if (s.choice) parts.push('sentiment: ' + s.choice + (typeof s.confidence === 'number' ? ' (' + Math.round(s.confidence * 100) + '%)' : ''));
    if (typeof f.noul === 'number') parts.push('frustrated: ' + (f.noul >= 0.5 ? 'yes' : 'no') + ' (' + f.noul.toFixed(2) + ')');
    if (typeof u.noul === 'number') parts.push('urgent: ' + (u.noul >= 0.5 ? 'yes' : 'no') + ' (' + u.noul.toFixed(2) + ')');
    if (typeof h.score === 'number' && h.legend) {
      var keys = Object.keys(h.legend).sort(function (x, y) { return Number(x) - Number(y); });
      var level = h.legend[String(Math.round(h.score))] || h.legend[keys[keys.length - 1]];
      parts.push('lead heat: ' + level + ' (' + h.score.toFixed(2) + ')');
    }
    if (!parts.length) return null;
    return { summary: parts.join(' \u00b7 '), answers: a };
  } catch (e) {
    return null;
  }
}

/* ---------------- lead from the site chat/form ---------------- */

function handleLead(body) {
  var name = String(body.name || '').trim();
  var email = String(body.email || '').trim();
  var phone = String(body.phone || '').replace(/^\(skipped\)$/, '').trim();
  var topic = String(body.topic || '').trim();
  var source = String(body.source || 'website chat');

  if (!email || email.indexOf('@') < 0) return { ok: false, error: 'valid email required' };

  // 0. Sentiment: score the conversation transcript (or the topic line) with a
  //    self-hosted Kev decision model when KEV_ENDPOINT is configured. Runs
  //    before the HubSpot push so the tag lands on the contact record. When
  //    Kev reads urgency or frustration in the tone of the conversation, the
  //    owner alert escalates (subject prefix + explicit reply-today line).
  var mood = kevSentiment(String(body.transcript || '').trim() || topic);
  var urgent = false;
  if (mood && mood.answers) {
    var ua = mood.answers.urgent || {}, fa = mood.answers.frustrated || {};
    urgent = (typeof ua.noul === 'number' && ua.noul >= 0.7) || (typeof fa.noul === 'number' && fa.noul >= 0.7);
  }

  var parts = name.split(/\s+/);
  var hub = {
    email: email,
    firstname: parts[0] || '',
    lastname: parts.slice(1).join(' ') || '',
    phone: phone,
    message: topic + (mood ? ' [Kev] ' + mood.summary : '') + (phone ? '' : ' [phone: not provided]')
  };
  var hubResult = pushToHubSpot(hub);

  // 1.5. Enrich: fetch the company website behind the email domain, upsert the
  //      HubSpot company, personalise the drafted reply with what we found.
  var enrichment = { domain: '', notes: '', company: '', linkedin: [] };
  try { enrichment = enrichLead(email, hubResult.id || ''); }
  catch (e) { enrichment.notes = '[enrichment unavailable: ' + e + ']'; }
  if (enrichment.notes) hub.message = (hub.message ? hub.message + ' ' : '') + '[enriched] ' + enrichment.notes;

  // 1.25. Whole conversation → timeline note on the contact, so the full
  //       chat context is in the CRM, not just the topic line. Best-effort.
  var transcriptStatus = '';
  try { transcriptStatus = pushTranscriptNote(hubResult.id, String(body.transcript || '').trim(), mood ? mood.summary : ''); }
  catch (e) { transcriptStatus = 'transcript note error: ' + e; }

  // 1. Email to the requester — Gemini-drafted when a key is configured,
  //    otherwise a clean fixed confirmation so the reply always goes out.
  //    Both paths render through the branded HTML template with the CTA button.
  var subject = 'Your AI question' + (topic ? ' — ' + topic.slice(0, 60) : '') + ' (AI Pilot to Production)';
  var requester;
  try {
    var prompt = leadPrompt(name || 'there', topic || 'exploring AI for their business', source, enrichment.notes);
    requester = geminiToGmail(email, subject, prompt, name || 'there', { ctaUrl: 'https://calendly.com/kudtarkar-parag/30min' });
  } catch (err) {
    var fixed = 'Hi ' + (name || 'there') + ',' +
      '\n\nThanks for reaching out via the website' + (topic ? ' about ' + topic : '') + '.' +
      '\n\nI will come back to you personally with a proper answer — usually the same day.' +
      '\nIf it is easier, book a 30-minute intro call directly.';
    var opts = { htmlBody: emailHtml(fixed, { ctaUrl: 'https://calendly.com/kudtarkar-parag/30min' }) };
    if (cfg('AUTO_SEND') === 'true') { GmailApp.sendEmail(email, subject, fixed, opts); requester = { to: email, action: 'sent', mode: 'fixed' }; }
    else { GmailApp.createDraft(email, subject, fixed, opts); requester = { to: email, action: 'drafted', mode: 'fixed' }; }
  }

  // 2. Email to the owner — full details of every lead, always sent; subject
  //    escalates when Kev read urgency or frustration in the conversation.
  var owner = notifyOwner({ name: name, email: email, phone: phone, topic: topic, source: source, hubspot: hubResult.info, enrichment: enrichment, mood: mood, urgent: urgent, transcriptStatus: transcriptStatus });

  return {
    ok: true,
    hubspot: hubResult.info,
    transcript: transcriptStatus,
    mood: mood ? mood.summary : null,
    urgent: urgent,
    enrichment: { domain: enrichment.domain, company: enrichment.company, linkedin: enrichment.linkedin },
    email: requester,
    ownerNotified: owner,
    mode: cfg('AUTO_SEND') === 'true' ? 'sent' : 'drafted'
  };
}

function notifyOwner(lead) {
  var to = cfg('OWNER_EMAIL');
  if (!to) return 'skipped (OWNER_EMAIL not set)';
  var lines = [
    'New enquiry via ' + lead.source,
    '',
    'Name: ' + (lead.name || '(not given)'),
    'Email: ' + (lead.email || '(not given)'),
    'Phone: ' + (lead.phone || '(not given)'),
    'Interest: ' + (lead.topic || '(not given)'),
    'HubSpot: ' + String(lead.hubspot || 'n/a')
  ];
  var enr = lead.enrichment || {};
  if (enr.company || enr.notes) {
    lines.push('', '— Enrichment (auto) —');
    if (enr.company) lines.push('Company: ' + enr.company + (enr.domain ? ' (' + enr.domain + ')' : ''));
    if (enr.notes) lines.push('Website intel: ' + enr.notes);
    if (enr.linkedin && enr.linkedin.length) lines.push('LinkedIn (from their site): ' + enr.linkedin.join(' | '));
    if (enr.domain) lines.push('Find them on LinkedIn: ' + linkedinSearchUrl(lead.name || '', enr.company || enr.domain, enr.domain));
  }
  if (lead.mood && lead.mood.summary) {
    lines.push('', '\u2014 Sentiment (Kev) \u2014', lead.mood.summary);
    if (lead.urgent) lines.push('Kev reads this conversation as URGENT/FRUSTRATED \u2014 reply today.');
  }
  lines.push('', 'Reply to the enquirer: ' + lead.email,
    'Book them in: https://calendly.com/kudtarkar-parag/30min',
    'Chat transcript: ' + (lead.transcriptStatus || 'not stored'));
  var body = lines.join('\n');
  var urgent = !!(lead.urgent);
  var subject = (urgent ? '\u26A0\uFE0F URGENT \u2014 ' : '') + 'New lead — ' + (lead.name || lead.email) + (lead.topic ? ' · ' + String(lead.topic).slice(0, 50) : '');
  GmailApp.sendEmail(to, subject, body, { htmlBody: emailHtml(body, { ctaUrl: 'https://calendly.com/kudtarkar-parag/30min', ctaLabel: 'Open their detail in HubSpot' }) });
  return 'sent to ' + to;
}

/* ---------------- cold outreach to an SME ---------------- */

function handleCold(body) {
  var email = String(body.email || '').trim();
  if (!email || email.indexOf('@') < 0) return { ok: false, error: 'valid email required' };
  var company = String(body.company || '').trim();
  var industry = String(body.industry || 'SME').trim();
  var contactName = String(body.contactName || 'there').trim();
  var notes = String(body.notes || '').trim();

  // Enrich from the prospect's own website so the LLM opens with their reality.
  var enrichment = { domain: '', notes: '', company: '', linkedin: [] };
  try { enrichment = enrichLead(email, ''); } catch (e) { enrichment.notes = ''; }
  if (enrichment.company && !company) company = enrichment.company;
  var allNotes = [notes, enrichment.notes].filter(Boolean).join(' ');

  var subject = industry + ' ' + (company || 'business') + ' — practical AI, first step';
  var prompt = coldPrompt(contactName, company, industry, allNotes);
  var res = geminiToGmail(email, subject, prompt, contactName);
  return { ok: true, email: res, enrichment: { domain: enrichment.domain, company: enrichment.company, linkedin: enrichment.linkedin }, mode: cfg('AUTO_SEND') === 'true' ? 'sent' : 'drafted' };
}

/* ---------------- prompts ---------------- */

function persona() {
  return [
    'You write short first-touch business emails for the AI consulting practice of Parag Kudtarkar, "AI Pilot to Production", based in Singapore, working globally.',
    'Voice: evidence-led, plain, warm, zero hype. British/Singaporean business English.',
    'Hard rules:',
    '- Under 120 words. 3 short paragraphs max. No bullet lists.',
    '- Never invent facts, client names, results, case studies, metrics, or prices.',
    '- No "I hope this finds you well" cliches. Open with the recipient, not yourself.',
    '- One clear, small ask: a 30-minute intro call (link goes in the signature, do not paste URLs).',
    '- Sign off as "' + (cfg('SENDER_NAME') || 'Parag — AI Pilot to Production') + '" (an AI strategy & delivery practice).',
    '- Subject line: return on its own first line, prefixed "Subject: ".'
  ].join('\n');
}

function leadPrompt(name, topic, source, enrichNotes) {
  return persona() +
    '\n\nContext: ' + name + ' just ' + source + ' on the AI Pilot to Production website and is interested in: ' + topic + '.' +
    (enrichNotes ? '\n\nAbout their company (auto-scraped from their own website — use to personalise the opening line, do not invent beyond it): ' + enrichNotes : '') +
    '\nWrite a same-day reply: acknowledge their interest specifically, add one useful, safe, general insight about the topic (no invented facts), then propose the 30-minute intro call.';
}

function coldPrompt(contactName, company, industry, notes) {
  return persona() +
    '\n\nContext: first-touch outreach to ' + (contactName || 'the owner') + ' at ' + (company || 'an ' + industry + ' business') +
    ' (' + industry + '). Notes: ' + (notes || 'none.') +
    '\nMention ONE realistic AI use case typical for this industry that saves staff time on a manual process (frame it as a question about their current process, not a claim about their business).' +
    '\nThen propose the 30-minute intro call. Keep it honest: no claims of past results with named clients.';
}

/* ---------------- plumbing ---------------- */

/* Drafting provider — set ONE property, LLM_API_KEY. The provider is
   auto-detected from the key prefix:
     gsk_…  → Groq Cloud   (llama-3.3-70b-versatile, OpenAI-compatible)
     xai-…  → xAI Grok     (grok-4-fast, OpenAI-compatible)
     AIza…  → Google Gemini (gemini-2.0-flash)
   Legacy properties GROK_KEY / GEMINI_KEY still work. If nothing is set,
   callers fall back to a fixed-text email — the pipeline never breaks. */
function draftText(prompt) {
  var chain = [];
  var key = cfg('LLM_API_KEY');
  if (key) {
    if (key.indexOf('gsk_') === 0) chain.push([groqCloudDraft, key]);
    else if (key.indexOf('xai-') === 0) chain.push([grokDraft, key]);
    else if (key.indexOf('AIza') === 0) chain.push([geminiDraft, key]);
  }
  var grok = cfg('GROK_KEY'); if (grok) chain.push([grokDraft, grok]);
  var gem = cfg('GEMINI_KEY'); if (gem) chain.push([geminiDraft, gem]);

  var errors = [];
  for (var i = 0; i < chain.length; i++) {
    try { return chain[i][0](prompt, chain[i][1]); }
    catch (err) { errors.push('provider ' + (i + 1) + ': ' + err); }
  }
  throw new Error('all LLM providers failed' + (errors.length ? ' — ' + errors.join('; ') : ' (no LLM_API_KEY configured)'));
}

function groqCloudDraft(prompt, key) {
  var payload = {
    model: cfg('LLM_MODEL') || 'llama-3.3-70b-versatile',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.4,
    max_tokens: 400
  };
  var res = UrlFetchApp.fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + key },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  var code = res.getResponseCode();
  var text = res.getContentText();
  if (code !== 200) throw new Error('Groq ' + code + ': ' + text.slice(0, 200));
  var data = JSON.parse(text);
  var out = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (!out) throw new Error('Groq returned no text');
  return String(out).trim();
}

function grokDraft(prompt, key) {
  var payload = {
    model: cfg('GROK_MODEL') || 'grok-4-fast' ,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.4,
    max_tokens: 400
  };
  var res = UrlFetchApp.fetch('https://api.x.ai/v1/chat/completions', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + key },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  var code = res.getResponseCode();
  var text = res.getContentText();
  if (code !== 200) throw new Error('Grok ' + code + ': ' + text.slice(0, 200));
  var data = JSON.parse(text);
  var out = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (!out) throw new Error('Grok returned no text');
  return String(out).trim();
}

function geminiDraft(prompt, key) {
  var payload = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.4, maxOutputTokens: 400 }
  };
  var res = UrlFetchApp.fetch(GEMINI_URL + key, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  var code = res.getResponseCode();
  var text = res.getContentText();
  if (code !== 200) throw new Error('Gemini ' + code + ': ' + text.slice(0, 200));
  var data = JSON.parse(text);
  var out = data.candidates && data.candidates[0] && data.candidates[0].content &&
    data.candidates[0].content.parts && data.candidates[0].content.parts[0].text;
  if (!out) throw new Error('Gemini returned no text');
  return String(out).trim();
}

function splitSubject(text, fallback) {
  var m = text.match(/^subject:\s*(.+)$/im);
  if (m) return { subject: m[1].trim(), body: text.replace(/^subject:.*$/im, '').trim() };
  return { subject: fallback, body: text };
}

/* ---------------- branded HTML email template ----------------
   Wordmark PNG hosted on the site (email clients don't render SVG).
   Override with the LOGO_URL script property if the path ever moves.  */
function LOGO_URL() { return cfg('LOGO_URL') || 'https://kudtarkar.life/assets/wordmark-email.png'; }

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function emailHtml(bodyText, opts) {
  opts = opts || {};
  var paras = String(bodyText || '').split(/\n{2,}/).map(function (p) {
    return '<p style="margin:0 0 14px;">' + esc(p).replace(/\n/g, '<br>') + '</p>';
  }).join('');
  var cta = opts.ctaUrl
    ? '<table role="presentation" cellpadding="0" cellspacing="0" style="margin:20px 0 6px;"><tr><td style="background:#A9C23F;border-radius:999px;">' +
      '<a href="' + esc(opts.ctaUrl) + '" style="display:inline-block;padding:12px 26px;font-family:Georgia,serif;font-size:15px;font-weight:bold;color:#0C3027;text-decoration:none;border-radius:999px;">' +
      esc(opts.ctaLabel || 'Book a 30-minute intro call') + '</a></td></tr></table>'
    : '';
  var sender = cfg('SENDER_NAME') || 'Parag — AI Pilot to Production';
  return '' +
  '<div style="margin:0;padding:24px 12px;background:#F7F3EC;">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 auto;background:#FFFFFF;border-radius:14px;border:1px solid #E3DCCB;border-collapse:separate;overflow:hidden;">' +
      '<tr><td style="padding:26px 32px 14px 32px;background:#F7F3EC;">' +
        '<a href="https://kudtarkar.life/" style="text-decoration:none;"><img src="' + LOGO_URL() + '" alt="AI Pilot to Production" width="300" style="display:block;width:300px;max-width:100%;height:auto;border:0;"></a>' +
      '</td></tr>' +
      '<tr><td style="padding:14px 32px 8px 32px;font-family:Georgia,serif;color:#0F2A20;font-size:17px;line-height:1.55;">' + paras + cta + '</td></tr>' +
      '<tr><td style="padding:18px 32px 26px 32px;border-top:1px solid #E3DCCB;font-family:Arial,sans-serif;font-size:12px;line-height:1.6;color:#5C6B62;">' +
        '<strong style="color:#0F2A20;">' + esc(sender) + '</strong><br>' +
        'AI strategy &amp; delivery · Singapore · working globally (US &amp; UK)<br>' +
        '<a href="https://kudtarkar.life/" style="color:#4F665A;">kudtarkar.life</a> · ' +
        '<a href="https://calendly.com/kudtarkar-parag/30min" style="color:#4F665A;">Book a call</a> · ' +
        '<a href="https://medium.com/@kudtarkar.parag" style="color:#4F665A;">Writing</a><br>' +
        (cfg('BUSINESS_ADDRESS') ? esc(cfg('BUSINESS_ADDRESS')) + '<br>' : '') +
        'Prefer not to hear from me? Reply "no thanks" and that\u2019s the last you will.' +
      '</td></tr>' +
    '</table>' +
  '</div>';
}

function signature() {
  return '\n\n—\n' + (cfg('SENDER_NAME') || 'Parag — AI Pilot to Production') + '\nAI strategy & delivery · Singapore · global\nBook directly: https://calendly.com/kudtarkar-parag\nPrefer not to hear from me? Reply "no thanks" and that\u2019s the last you will.';
}

function geminiToGmail(to, fallbackSubject, prompt, name, opts) {
  opts = opts || {};
  var drafted = splitSubject(draftText(prompt), fallbackSubject);
  var body = drafted.body + signature();
  var html = emailHtml(drafted.body, {
    ctaUrl: opts.ctaUrl || 'https://calendly.com/kudtarkar-parag/30min',
    ctaLabel: opts.ctaLabel || 'Book a 30-minute intro call'
  });
  var mailOpts = { htmlBody: html };
  if (cfg('AUTO_SEND') === 'true') {
    GmailApp.sendEmail(to, drafted.subject, body, mailOpts);
    return { to: to, subject: drafted.subject, action: 'sent' };
  }
  GmailApp.createDraft(to, drafted.subject, body, mailOpts);
  return { to: to, subject: drafted.subject, action: 'drafted' };
}

function pushToHubSpot(hub) {
  var portal = cfg('PORTAL_ID'), guid = cfg('FORM_GUID');
  var token = hsToken();
  /* Preferred path: CRM v3 (needs HUBSPOT_PRIVATE_TOKEN) — returns the contact id
     so enrichment can attach the company record and associations. */
  if (token) {
    try {
      var props = {
        email: hub.email,
        firstname: hub.firstname || '',
        lastname: hub.lastname || '',
        phone: hub.phone || '',
        message: hub.message || ''
      };
      var search = UrlFetchApp.fetch('https://api.hubapi.com/crm/v3/objects/contacts/search?filterGroups=' + encodeURIComponent(
        '[{"filters":[{"value":"' + hub.email + '","propertyName":"email","operator":"EQ"}]}]') + '&limit=1', {
        headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true
      });
      if (search.getResponseCode() === 200) {
        var found = JSON.parse(search.getContentText() || '{}');
        if (found.total && found.results && found.results[0]) {
          var id = found.results[0].id;
          var upd = UrlFetchApp.fetch('https://api.hubapi.com/crm/v3/objects/contacts/' + id, {
            method: 'patch', headers: { Authorization: 'Bearer ' + token },
            contentType: 'application/json', payload: JSON.stringify({ properties: props }), muteHttpExceptions: true
          });
          return { id: id, info: 'contact updated (' + upd.getResponseCode() + ')' };
        }
      }
      var created = UrlFetchApp.fetch('https://api.hubapi.com/crm/v3/objects/contacts', {
        method: 'post', headers: { Authorization: 'Bearer ' + token },
        contentType: 'application/json', payload: JSON.stringify({ properties: props }), muteHttpExceptions: true
      });
      if (created.getResponseCode() >= 200 && created.getResponseCode() < 300) {
        var cid = String(JSON.parse(created.getContentText() || '{}').id || '');
        return { id: cid, info: 'contact created (' + created.getResponseCode() + ')' };
      }
      return { id: '', info: 'crm create failed HTTP ' + created.getResponseCode() + ' — falling back to forms api' };
    } catch (e) {
      return { id: '', info: 'crm error: ' + e + ' — falling back to forms api' };
    }
  }
  /* Fallback: classic Forms API (no contact id available). */
  if (!portal || !guid) return { id: '', info: 'skipped (HubSpot not configured)' };
  var fields = [
    { name: 'email', value: hub.email },
    { name: 'firstname', value: hub.firstname },
    { name: 'lastname', value: hub.lastname },
    { name: 'phone', value: hub.phone },
    { name: 'message', value: hub.message }
  ];
  var res = UrlFetchApp.fetch(HUBSPOT_FORMS + portal + '/' + guid, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({ fields: fields, context: { pageName: 'Orbit chat assistant' } }),
    muteHttpExceptions: true
  });
  return { id: '', info: 'HTTP ' + res.getResponseCode() + ' (forms api)' };
}

/* ---------------- chat transcript → HubSpot timeline note ----------------
   Stores the whole conversation as a note on the contact's timeline so the
   full context is visible and searchable in the CRM. Uses the same bearer
   token as the contact upsert; never fails the lead — any error is logged
   into the returned status only. */

function pushTranscriptNote(contactId, transcript, moodSummary) {
  try {
    var body = String(transcript || '').trim();
    if (!contactId || !body) return '';
    var note = 'Orbit chat transcript \u2014 ' + Utilities.formatDate(new Date(), Session.getScriptTimeZone() || 'UTC', 'd MMM yyyy HH:mm') +
      (moodSummary ? '\nKev: ' + moodSummary : '') + '\n\n' + body;
    if (note.length > 60000) note = '\u2026' + note.slice(-60000);
    var token = hsToken();
    if (!token) return '';
    var res = UrlFetchApp.fetch('https://api.hubapi.com/crm/v3/objects/notes', {
      method: 'post',
      headers: { Authorization: 'Bearer ' + token },
      contentType: 'application/json',
      payload: JSON.stringify({
        properties: { hs_timestamp: new Date().toISOString(), hs_note_body: note },
        associations: [{ to: { id: contactId }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 202 }] }]
      }),
      muteHttpExceptions: true
    });
    var code = res.getResponseCode();
    return (code >= 200 && code < 300) ? 'transcript note stored' : 'transcript note failed HTTP ' + code;
  } catch (e) {
    return 'transcript note error: ' + e;
  }
}

/* ---------------- lead enrichment (company website + LinkedIn pointers) ----------------
   Given the lead's email domain, fetch their public website, extract identity,
   description, social links and tech signals, upsert a HubSpot COMPANY, associate it
   with the contact, and return a summary that (a) personalises the LLM-drafted email
   and (b) lands in the owner notification.
   LinkedIn policy note: LinkedIn blocks anonymous scraping (and it breaches their ToS).
   We therefore only harvest LinkedIn URLs that the company publishes on its own site,
   optionally read public og:* meta from a company page when LinkedIn serves it, and
   otherwise hand the owner a click-ready people-search URL. No credential scraping. */

var FREE_MAIL = { 'gmail.com': 1, 'googlemail.com': 1, 'yahoo.com': 1, 'ymail.com': 1, 'hotmail.com': 1, 'outlook.com': 1, 'live.com': 1, 'msn.com': 1, 'icloud.com': 1, 'me.com': 1, 'aol.com': 1, 'protonmail.com': 1, 'proton.me': 1, 'gmx.com': 1, 'gmx.net': 1, 'mail.com': 1, 'mail.ru': 1, 'yandex.com': 1, 'zoho.com': 1, 'hey.com': 1 };

function fetchPage(url) {
  var res = UrlFetchApp.fetch(url, {
    muteHttpExceptions: true, followRedirects: true,
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; OrbitEnricher/1.0; +https://kudtarkar.life)' }
  });
  var code = res.getResponseCode();
  if (code < 200 || code >= 400) return { code: code, html: '' };
  return { code: code, html: String(res.getContentText() || '') };
}

function metaFromHtml(html) {
  var out = { title: '', description: '', siteName: '', linkedin: [], twitter: '', emails: [], tech: [] };
  if (!html) return out;
  var m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (m) out.title = m[1].replace(/\s+/g, ' ').trim().slice(0, 150);
  m = html.match(/<meta[^>]+name=["']description["'][^>]*content=["']([\s\S]*?)["']/i) ||
      html.match(/<meta[^>]+content=["']([\s\S]*?)["'][^>]*name=["']description["']/i);
  if (m) out.description = m[1].replace(/\s+/g, ' ').trim().slice(0, 300);
  m = html.match(/<meta[^>]+property=["']og:site_name["'][^>]*content=["']([\s\S]*?)["']/i);
  if (m) out.siteName = m[1].trim().slice(0, 100);
  var re = /https?:\/\/(?:[a-z]{2,4}\.)?linkedin\.com\/(?:company|in)\/[A-Za-z0-9_%\-.\/]+/gi, hit, seen = {};
  while ((hit = re.exec(html)) !== null) {
    var u = hit[0].replace(/[\"'>].*$/, '');
    if (!seen[u]) { seen[u] = 1; out.linkedin.push(u); }
  }
  m = html.match(/https?:\/\/(?:www\.)?twitter\.com\/[A-Za-z0-9_]{2,15}/i);
  if (m) out.twitter = m[0];
  var em = new RegExp('[A-Za-z0-9._%+-]+@' + '(?:[A-Za-z0-9.-]+)', 'gi'), eh = {}, emHit;
  while ((emHit = em.exec(html)) !== null && out.emails.length < 3) {
    var addr = emHit[0].toLowerCase();
    if (!eh[addr]) { eh[addr] = 1; out.emails.push(addr); }
  }
  var techs = ['hubspot', 'wordpress', 'shopify', 'wix', 'squarespace', 'salesforce', 'intercom', 'drupal', 'webflow', 'marketo'];
  for (var t = 0; t < techs.length; t++) if (html.toLowerCase().indexOf(techs[t]) !== -1) out.tech.push(techs[t]);
  return out;
}

function enrichLead(email, contactId) {
  var out = { domain: '', notes: '', company: '', linkedin: [] };
  try {
    var domain = String(email || '').split('@')[1] || '';
    if (!domain || FREE_MAIL[domain.toLowerCase()]) { out.notes = 'free-mail domain — no company enrichment'; return out; }
    out.domain = domain;
    var root = fetchPage('https://' + domain + '/');
    if (!root.html) root = fetchPage('https://www.' + domain + '/');
    var meta = metaFromHtml(root.html);
    if (!meta.description || meta.description.length < 40) {
      var alts = ['/about', '/about-us', '/company'], i, alt;
      for (i = 0; i < alts.length && (!meta.description || meta.description.length < 40); i++) {
        alt = fetchPage('https://' + domain + alts[i]);
        if (alt.html) { var am = metaFromHtml(alt.html); if (am.description && am.description.length > meta.description.length) meta.description = am.description; }
      }
    }
    var companyName = meta.siteName || (meta.title ? meta.title.split(/[|\u2013\u2014\-·]/)[0].trim() : '');
    out.company = companyName;
    out.linkedin = meta.linkedin;
    out.notes = (companyName ? 'Company: ' + companyName + '. ' : '') +
      (meta.description ? 'Their site says: "' + meta.description + '". ' : '') +
      (meta.tech.length ? 'Site tech hints: ' + meta.tech.join(', ') + '. ' : '') +
      (meta.linkedin.length ? 'LinkedIn page(s) on their site: ' + meta.linkedin.join(' ') + '. ' : '') +
      (meta.emails.length ? 'Public emails on site: ' + meta.emails.join(', ') + '.' : '');
    if (!token_()) return out;
    upsertCompany(out, contactId);
  } catch (e) {
    out.notes += ' [enrichment error: ' + e + ']';
  }
  return out;
}

/* ---------------- HubSpot auth: modern OAuth (new dev platform) or legacy PAT ----------------
   Preferred: OAuth app created on the new developer platform.
     One-time setup:
       1. Script properties: HUBSPOT_CLIENT_ID, HUBSPOT_CLIENT_SECRET,
          HUBSPOT_REDIRECT_URI (must match the redirect URL registered on the app,
          e.g. https://script.google.com)
       2. Run oauthAuthorizeUrl() → open the printed URL → approve → the browser
          lands on your redirect URI with ?code=… in the address bar → copy the code
       3. Script property HUBSPOT_AUTH_CODE = that code → run oauthExchange() once
          → a long-lived HUBSPOT_REFRESH_TOKEN is stored automatically.
     After that hsToken() silently trades refresh→access tokens (30-min TTL, cached).
   Still supported: a static private-app token in HUBSPOT_PRIVATE_TOKEN (legacy path). */
function hsToken() {
  var pat = cfg('HUBSPOT_PRIVATE_TOKEN');
  if (pat) return pat;
  var refresh = cfg('HUBSPOT_REFRESH_TOKEN');
  if (!refresh) return '';
  var props = PropertiesService.getScriptProperties();
  var cached = props.getProperty('HS_ACCESS_TOKEN_CACHE');
  var cachedAt = Number(props.getProperty('HS_ACCESS_TOKEN_AT') || 0);
  if (cached && Date.now() - cachedAt < 25 * 60 * 1000) return cached;
  var res = UrlFetchApp.fetch('https://api.hubapi.com/oauth/v1/token', {
    method: 'post',
    contentType: 'application/x-www-form-urlencoded',
    payload: 'grant_type=refresh_token&refresh_token=' + encodeURIComponent(refresh) +
      '&client_id=' + encodeURIComponent(cfg('HUBSPOT_CLIENT_ID') || '') +
      '&client_secret=' + encodeURIComponent(cfg('HUBSPOT_CLIENT_SECRET') || ''),
    muteHttpExceptions: true
  });
  if (res.getResponseCode() < 200 || res.getResponseCode() >= 300) {
    throw new Error('oauth refresh failed HTTP ' + res.getResponseCode());
  }
  var data = JSON.parse(res.getContentText());
  props.setProperty('HS_ACCESS_TOKEN_CACHE', String(data.access_token || ''));
  props.setProperty('HS_ACCESS_TOKEN_AT', String(Date.now()));
  if (data.refresh_token && data.refresh_token !== refresh) props.setProperty('HUBSPOT_REFRESH_TOKEN', data.refresh_token);
  return String(data.access_token || '');
}

function oauthAuthorizeUrl() {
  var cid = cfg('HUBSPOT_CLIENT_ID');
  if (!cid) return 'Set HUBSPOT_CLIENT_ID (and HUBSPOT_CLIENT_SECRET, HUBSPOT_REDIRECT_URI) first, then run this again.';
  var uri = cfg('HUBSPOT_REDIRECT_URI') || 'https://script.google.com';
  var scopes = ['crm.objects.contacts.read', 'crm.objects.contacts.write', 'crm.objects.companies.read', 'crm.objects.companies.write'].join(' ');
  return 'https://app.hubspot.com/oauth/authorize?client_id=' + encodeURIComponent(cid) +
    '&redirect_uri=' + encodeURIComponent(uri) +
    '&scope=' + encodeURIComponent(scopes);
}

function oauthExchangeWithCode(code) {
  var res = UrlFetchApp.fetch('https://api.hubapi.com/oauth/v1/token', {
    method: 'post',
    contentType: 'application/x-www-form-urlencoded',
    payload: 'grant_type=authorization_code&code=' + encodeURIComponent(code) +
      '&client_id=' + encodeURIComponent(cfg('HUBSPOT_CLIENT_ID') || '') +
      '&client_secret=' + encodeURIComponent(cfg('HUBSPOT_CLIENT_SECRET') || '') +
      '&redirect_uri=' + encodeURIComponent(cfg('HUBSPOT_REDIRECT_URI') || 'https://script.google.com'),
    muteHttpExceptions: true
  });
  if (res.getResponseCode() < 200 || res.getResponseCode() >= 300) {
    return 'exchange failed HTTP ' + res.getResponseCode() + ' — check CLIENT_ID/SECRET/REDIRECT_URI match the app settings';
  }
  var data = JSON.parse(res.getContentText());
  PropertiesService.getScriptProperties().setProperty('HUBSPOT_REFRESH_TOKEN', String(data.refresh_token || ''));
  return 'stored HUBSPOT_REFRESH_TOKEN — enrichment is now live';
}

function oauthExchange() {
  var code = cfg('HUBSPOT_AUTH_CODE');
  if (!code) return 'Open oauthAuthorizeUrl() output, approve access, copy the ?code= from the redirect URL into script property HUBSPOT_AUTH_CODE, then run this again.';
  var out = oauthExchangeWithCode(code);
  if (String(out).indexOf('stored') === 0) PropertiesService.getScriptProperties().deleteProperty('HUBSPOT_AUTH_CODE');
  return out;
}

function token_() {
  return hsToken();
}

function upsertCompany(enr, contactId) {
  var token = token_();
  var props = { domain: enr.domain };
  if (enr.company) props.name = enr.company;
  var headers = { Authorization: 'Bearer ' + token }, companyId = '', code;
  var search = UrlFetchApp.fetch('https://api.hubapi.com/crm/v3/objects/companies/search?filterGroups=' + encodeURIComponent(
    '[{"filters":[{"value":"' + enr.domain + '","propertyName":"domain","operator":"EQ"}]}]') + '&limit=1', {
    headers: headers, muteHttpExceptions: true
  });
  if (search.getResponseCode() === 200) {
    var found = JSON.parse(search.getContentText() || '{}');
    if (found.total && found.results && found.results[0]) companyId = String(found.results[0].id);
  }
  if (companyId) {
    var upd = UrlFetchApp.fetch('https://api.hubapi.com/crm/v3/objects/companies/' + companyId, {
      method: 'patch', headers: headers, contentType: 'application/json',
      payload: JSON.stringify({ properties: props }), muteHttpExceptions: true
    });
    code = upd.getResponseCode();
    if (code < 200 || code >= 300) return;
  } else {
    var cr = UrlFetchApp.fetch('https://api.hubapi.com/crm/v3/objects/companies', {
      method: 'post', headers: headers, contentType: 'application/json',
      payload: JSON.stringify({ properties: props }), muteHttpExceptions: true
    });
    code = cr.getResponseCode();
    if (code < 200 || code >= 300) return;
    companyId = String(JSON.parse(cr.getContentText() || '{}').id || '');
  }
  enr.notes += ' [HubSpot company ' + companyId + ' linked]';
  if (contactId && companyId) {
    try {
      UrlFetchApp.fetch('https://api.hubapi.com/crm/v4/objects/companies/' + companyId + '/associations/contacts/' + contactId, {
        method: 'put', headers: headers, contentType: 'application/json',
        payload: JSON.stringify([{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 1 }]),
        muteHttpExceptions: true
      });
    } catch (e) { /* association is best-effort */ }
  }
}

function linkedinSearchUrl(name, domain, company) {
  var bits = [];
  if (name) bits.push(name);
  if (company) bits.push(company);
  if (domain) bits.push(domain);
  return 'https://www.linkedin.com/search/results/people/?keywords=' + encodeURIComponent(bits.join(' '));
}

/* ---------------- manual test harness (run from the editor) ---------------- */

function testLead() {
  var fake = {
    postData: { contents: JSON.stringify({
      token: 'REPLACE-ME',
      name: 'Asha Nair',
      email: 'asha@example.com',
      phone: '(skipped)',
      topic: 'AI CoE for a medtech SME',
      source: 'website chat'
    }) }
  };
  Logger.log(JSON.stringify(doPost(fake), null, 2));
}
