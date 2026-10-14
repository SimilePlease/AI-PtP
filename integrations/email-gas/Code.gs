/**
 * AI-PtP email automation — Google Apps Script (free with any Gmail account).
 *
 * What it does (all free):
 *   POST { token, name, email, phone, topic, source }   → chat/lead capture:
 *     1. Creates/updates the contact in HubSpot (keyless forms API)
 *     2. Asks Gemini (free API tier) to draft a personalized first-touch email
 *     3. Files it as a Gmail DRAFT for one-tap review & send
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
 *   SENDER_NAME  — signature name, e.g. 'Parag — AI-PtP'
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

/* ---------------- lead from the site chat/form ---------------- */

function handleLead(body) {
  var name = String(body.name || '').trim();
  var email = String(body.email || '').trim();
  var phone = String(body.phone || '').replace(/^\(skipped\)$/, '').trim();
  var topic = String(body.topic || '').trim();
  var source = String(body.source || 'website chat');

  if (!email || email.indexOf('@') < 0) return { ok: false, error: 'valid email required' };

  var parts = name.split(/\s+/);
  var hub = {
    email: email,
    firstname: parts[0] || '',
    lastname: parts.slice(1).join(' ') || '',
    phone: phone,
    message: topic + (phone ? '' : ' [phone: not provided]')
  };
  var hubResult = pushToHubSpot(hub);

  // 1. Email to the requester — Gemini-drafted when a key is configured,
  //    otherwise a clean fixed confirmation so the reply always goes out.
  var subject = 'Your AI question' + (topic ? ' — ' + topic.slice(0, 60) : '') + ' (AI-PtP)';
  var requester;
  try {
    var prompt = leadPrompt(name || 'there', topic || 'exploring AI for their business', source);
    requester = geminiToGmail(email, subject, prompt, name || 'there');
  } catch (err) {
    var fixed = 'Hi ' + (name || 'there') + ',' +
      '\n\nThanks for reaching out via the website' + (topic ? ' about ' + topic : '') + '.' +
      '\n\nI will come back to you personally with a proper answer — usually the same day.' +
      '\nIf it is easier, book a 30-minute intro call directly: https://calendly.com/kudtarkar-parag/30min' + signature();
    var opts = { htmlBody: '<p>' + fixed.replace(/\n\n+/g, '</p><p>').replace(/\n/g, '<br>') + '</p>' };
    if (cfg('AUTO_SEND') === 'true') { GmailApp.sendEmail(email, subject, fixed, opts); requester = { to: email, action: 'sent', mode: 'fixed' }; }
    else { GmailApp.createDraft(email, subject, fixed, opts); requester = { to: email, action: 'drafted', mode: 'fixed' }; }
  }

  // 2. Email to the owner — full details of every lead, always sent.
  var owner = notifyOwner({ name: name, email: email, phone: phone, topic: topic, source: source, hubspot: hubResult });

  return {
    ok: true,
    hubspot: hubResult,
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
    'HubSpot: ' + String(lead.hubspot || 'n/a'),
    '',
    'Reply to the enquirer: ' + lead.email,
    'Book them in: https://calendly.com/kudtarkar-parag/30min'
  ];
  var body = lines.join('\n');
  var subject = 'New lead — ' + (lead.name || lead.email) + (lead.topic ? ' · ' + String(lead.topic).slice(0, 50) : '');
  GmailApp.sendEmail(to, subject, body);
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

  var subject = industry + ' ' + (company || 'business') + ' — practical AI, first step';
  var prompt = coldPrompt(contactName, company, industry, notes);
  var res = geminiToGmail(email, subject, prompt, contactName);
  return { ok: true, email: res, mode: cfg('AUTO_SEND') === 'true' ? 'sent' : 'drafted' };
}

/* ---------------- prompts ---------------- */

function persona() {
  return [
    'You write short first-touch business emails for a solo AI consulting practice, "AI-PtP" (AI - Pilot to Production), based in Singapore, working globally.',
    'Voice: evidence-led, plain, warm, zero hype. British/Singaporean business English.',
    'Hard rules:',
    '- Under 120 words. 3 short paragraphs max. No bullet lists.',
    '- Never invent facts, client names, results, case studies, metrics, or prices.',
    '- No "I hope this finds you well" cliches. Open with the recipient, not yourself.',
    '- One clear, small ask: a 30-minute intro call (link goes in the signature, do not paste URLs).',
    '- Sign off as "' + (cfg('SENDER_NAME') || 'Parag — AI-PtP') + '" (an AI strategy & delivery practice).',
    '- Subject line: return on its own first line, prefixed "Subject: ".'
  ].join('\n');
}

function leadPrompt(name, topic, source) {
  return persona() +
    '\n\nContext: ' + name + ' just ' + source + ' on the AI-PtP website and is interested in: ' + topic + '.' +
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

/* Drafting provider: xAI Grok (OpenAI-compatible) when GROK_KEY is set,
   otherwise Google Gemini when GEMINI_KEY is set. Either may be absent —
   callers must handle a thrown error (a fixed-text email is sent instead). */
function draftText(prompt) {
  var grok = cfg('GROK_KEY');
  if (grok) return grokDraft(prompt, grok);
  var gem = cfg('GEMINI_KEY');
  if (gem) return geminiDraft(prompt, gem);
  throw new Error('no LLM key configured (GROK_KEY or GEMINI_KEY)');
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

function signature() {
  return '\n\n—\n' + (cfg('SENDER_NAME') || 'Parag — AI-PtP') + '\nAI strategy & delivery · Singapore · global\nBook directly: https://calendly.com/kudtarkar-parag\nPrefer not to hear from me? Reply "no thanks" and that\u2019s the last you will.';
}

function geminiToGmail(to, fallbackSubject, prompt, name) {
  var drafted = splitSubject(draftText(prompt), fallbackSubject);
  var body = drafted.body + signature();
  var opts = { htmlBody: '<p>' + body.replace(/\n\n+/g, '</p><p>').replace(/\n/g, '<br>') + '</p>' };
  if (cfg('AUTO_SEND') === 'true') {
    GmailApp.sendEmail(to, drafted.subject, body, opts);
    return { to: to, subject: drafted.subject, action: 'sent' };
  }
  GmailApp.createDraft(to, drafted.subject, body, opts);
  return { to: to, subject: drafted.subject, action: 'drafted' };
}

function pushToHubSpot(hub) {
  var portal = cfg('PORTAL_ID'), guid = cfg('FORM_GUID');
  if (!portal || !guid) return 'skipped (HubSpot not configured)';
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
    payload: JSON.stringify({ fields: fields, context: { pageName: 'AI-PtP chat assistant' } }),
    muteHttpExceptions: true
  });
  return 'HTTP ' + res.getResponseCode();
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
