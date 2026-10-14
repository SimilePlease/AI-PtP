/* Site-wide structural test for index.html. Run: node tests/site.test.js */
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..");
const src = fs.readFileSync(path.join(root, "index.html"), "utf8");
const css = fs.readFileSync(path.join(root, "css/styles.css"), "utf8");
const agentJs = fs.readFileSync(path.join(root, "js/agent.js"), "utf8");
const mainJs = fs.readFileSync(path.join(root, "js/main.js"), "utf8");

let failures = 0;
function check(name, cond, detail) {
  if (cond) { console.log("  ok  " + name); }
  else { failures++; console.log("FAIL  " + name + (detail ? " \u2014 " + detail : "")); }
}

/* ---------- HTML structure ---------- */

const tags = ["div","section","form","ul","ol","li","a","button","aside","nav","footer","header","main","select","label","h1","h2","h3","h4","svg","iframe","textarea"];
for (const t of tags) {
  const open = (src.match(new RegExp("<" + t + "(\\s|>)", "g")) || []).length;
  const close = (src.match(new RegExp("</" + t + ">", "g")) || []).length;
  check("tag balance <" + t + ">", open === close, open + " open vs " + close + " close");
}

const ids = [...src.matchAll(/id="([^"]+)"/g)].map(m => m[1]);
const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
check("no duplicate ids", dupes.length === 0, [...new Set(dupes)].join(", "));

const idSet = new Set(ids);
const broken = new Set([...src.matchAll(/href="#([^"]+)"/g)].map(m => m[1]).filter(l => l !== "top" && !idSet.has(l)));
check("all anchors resolve", broken.size === 0, [...broken].join(", "));
check("#top exists for back-to-top", idSet.has("top") || !/href="#top"/.test(src));

const imgsNoAlt = [...src.matchAll(/<img[^>]*>/g)].filter(m => !/alt=/.test(m[0]));
check("all <img> have alt", imgsNoAlt.length === 0);

const inputsNoLabel = [...src.matchAll(/<input[^>]*id="([^"]+)"[^>]*>/g)]
  .filter(m => !new RegExp('for="' + m[1] + '"').test(src) && !/aria-label/.test(m[0]));
check("all inputs labelled", inputsNoLabel.length === 0, inputsNoLabel.map(m => m[1]).join(", "));

const selectNoLabel = [...src.matchAll(/<select[^>]*id="([^"]+)"[^>]*>/g)]
  .filter(m => !new RegExp('for="' + m[1] + '"').test(src) && !/aria-label/.test(m[0]));
check("all selects labelled", selectNoLabel.length === 0, selectNoLabel.map(m => m[1]).join(", "));

const missingAssets = [...src.matchAll(/(?:src|href)="((?!https?:|#|mailto:)[^"]+)"/g)]
  .map(m => m[1].split("?")[0])
  .filter(p => p && !p.startsWith("data:") && !fs.existsSync(path.join(root, p)));
check("all local assets exist", missingAssets.length === 0, missingAssets.join(", "));

/* ---------- JS wiring: every DOM id referenced in JS exists in HTML ---------- */

const htmlIds = new Set(ids);
for (const [name, jsSrc] of [["main.js", mainJs], ["agent.js", agentJs]]) {
  const refs = [...jsSrc.matchAll(/getElementById\('([^']+)'\)/g)].map(m => m[1]);
  const gone = refs.filter(r => !htmlIds.has(r) && !r.includes("yr-"));
  check(name + ": every getElementById target exists in HTML", gone.length === 0, gone.join(", "));
}

const classRefs = [...mainJs.matchAll(/querySelector(?:All)?\('\.([a-z-]+)/g)].map(m => m[1]);
const htmlClasses = new Set([...src.matchAll(/class="([^"]+)"/g)].flatMap(m => m[1].split(/\s+/)));
const runtimeClasses = new Set(["chat-cta", "reveal", "in", "expanded", "collapsing", "calendly-overlay", "calendly-popup"]);
const missingClasses = classRefs.filter(c => !htmlClasses.has(c) && !runtimeClasses.has(c));
check("main.js: every queried class exists in HTML", missingClasses.length === 0, missingClasses.join(", "));

/* ---------- CSS integrity ---------- */

const openBraces = (css.match(/{/g) || []).length;
const closeBraces = (css.match(/}/g) || []).length;
check("CSS braces balanced", openBraces === closeBraces, openBraces + " vs " + closeBraces);

const cssText = css.replace(/\/\*[\s\S]*?\*\//g, "");
const open2 = (cssText.match(/{/g) || []).length;
const close2 = (cssText.match(/}/g) || []).length;
check("CSS braces balanced excluding comments", open2 === close2);

const htmlClassList = new Set([...src.matchAll(/class="([^"]+)"/g)].flatMap(m => m[1].split(/\s+/)));
const definedSelectors = new Set([...cssText.matchAll(/\.([a-z][a-z0-9-]*)/gi)].map(m => m[1]));
const styledButUnused = [...htmlClassList].filter(c => c !== "reveal" && c !== "in" && !definedSelectors.has(c));
check("every HTML class has CSS (or JS state class)", styledButUnused.length === 0, styledButUnused.join(", "));

/* ---------- chat element contract (agent UI) ---------- */

for (const id of ["chat-fab","chat-panel","chat-status","chat-close","chat-msgs","chat-form","chat-text","chat-send","chat-progress-text","chat-unsupported"]) {
  check("chat element #" + id + " present", htmlIds.has(id));
}

/* ---------- content constraints ---------- */

const body = src.replace(/<script[\s\S]*?<\/script>/g, "");
check("no phone numbers", !/\+65|9\d{3}\s?\d{4}|\(\d{3}\)\s?\d{3}-\d{4}/.test(body));
check("no currency amounts", !/[$\u20B9\u20AC\u00A3]|\b(USD|SGD|INR|EUR)\s*\d/i.test(body));
check("no guarantee language", !/guarantee|assured results|risk-free/i.test(body));
check("no employer/client names", !/\b(employer|employer-name|client-name)\b/i.test(body));
check("contact email correct", (body.match(/parag@kudtarkar\.life/g) || []).length > 0);
const emails = [...body.matchAll(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi)].map(m => m[0]).filter(e => !/you@|name@|email@|company\.com|example\./i.test(e));
check("no other real email addresses", emails.every(e => e.toLowerCase() === "parag@kudtarkar.life"), emails.join(", "));
check("no generic 'welcome to the website' phrasing", !/welcome to the (website|site)/i.test(body));
check("popup URLs are clean (no embed_type=Inline — silent no-op bug)", mainJs.includes("calendlyUrl('30min', true)") && mainJs.includes("if (!forPopup)") && mainJs.includes("verrified") === false);
check("popup failure verifies overlay and never dead-ends", mainJs.includes("calendly-overlay") && mainJs.includes("calendlyState = 'failed'"));
check("booking CTA is a real link (not a JS-only button)", src.includes('<a class="btn btn-accent book-option"') && src.includes('target="_blank"') && mainJs.includes("createElement('a')"));
check("chat CTA falls back to native navigation", mainJs.includes("cta.target = '_blank'") && mainJs.includes("openCalendlyPopup"));
check("assistant named AI-PtP in prompt", agentJs.includes("AI-PtP Assistant") && agentJs.includes("Never greet"));
check("AI questions in scope (anti-deflection rule)", agentJs.includes("AI QUESTIONS ARE IN SCOPE"));
check("anti-hallucination rule present", agentJs.includes("no invented statistics") && agentJs.includes("say so honestly"));

/* ---------- design tokens ---------- */

for (const tok of ["--bg","--surface","--ink","--heading","--forest","--forest-deep","--moss","--lime","--lime-deep","--lime-soft","--line","--muted","--font-display","--font-body","--radius","--shadow-lift","--cream"]) {
  check("token " + tok + " defined", css.includes(tok + ":"));
}

/* ---------- external URLs inventory ---------- */

const ext = [...new Set([...src.matchAll(/(?:src|href)="(https?:[^"]+)"/g)].map(m => m[1].split("?")[0]))];
console.log("\nexternal URLs referenced by the page:");
ext.forEach(e => console.log("  " + e));
const known = ["https://calendly.com/kudtarkar-parag", "https://fonts.googleapis.com", "https://fonts.gstatic.com"];
check("external URLs are only known-good hosts", ext.every(u => known.some(k => u.startsWith(k))), ext.join(" | "));

console.log(failures === 0 ? "\nSITE TESTS: ALL PASSED" : "\nSITE TESTS: " + failures + " FAILURE(S)");
process.exit(failures === 0 ? 0 : 1);
