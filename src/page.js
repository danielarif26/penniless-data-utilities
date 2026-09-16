// The human-facing front door: a browser page that repairs malformed JSON.
//
// The paid API sells these passes to agents. This page gives the same passes to
// a person with a broken payload, for free, running entirely in their tab — no
// request reaches the Worker after the page loads, so it costs nothing to serve
// and nobody's data is sent anywhere.
//
// CLIENT_REPAIR below is a copy of src/repair.js compiled for the browser. The
// two are kept honest by test/page.test.js, which extracts this copy, runs it
// and the server module over the same inputs, and fails if they ever disagree.

import { PRICE } from "./shared.js";

const CLIENT_REPAIR = String.raw`
function tryParse(s) {
  try { return { ok: true, value: JSON.parse(s) }; }
  catch (e) { return { ok: false, error: e.message }; }
}

function stripFences(s) {
  const m = s.match(/^\s*` + "```" + String.raw`(?:json|JSON)?\s*\n?([\s\S]*?)\n?\s*` + "```" + String.raw`\s*$/);
  return m ? { text: m[1], applied: "fences" } : { text: s, applied: null };
}

function extractJsonRegion(s) {
  const firstObj = s.indexOf("{");
  const firstArr = s.indexOf("[");
  let start = -1;
  if (firstObj === -1 && firstArr === -1) return { text: s, applied: null };
  if (firstObj === -1) start = firstArr;
  else if (firstArr === -1) start = firstObj;
  else start = Math.min(firstObj, firstArr);
  const open = s[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0, inStr = false, esc = false, end = -1;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  if (end === -1) return { text: s.slice(start), applied: "unclosed-extract" };
  const extracted = s.slice(start, end + 1);
  if (extracted === s) return { text: s, applied: null };
  return { text: extracted, applied: "prose-extract" };
}

function stripComments(s) {
  let out = "", i = 0, inStr = false, esc = false, changed = false;
  while (i < s.length) {
    const c = s[i], n = s[i + 1];
    if (inStr) {
      out += c;
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      i++;
      continue;
    }
    if (c === '"') { inStr = true; out += c; i++; continue; }
    if (c === "/" && n === "/") {
      changed = true;
      while (i < s.length && s[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && n === "*") {
      changed = true;
      i += 2;
      while (i < s.length && !(s[i] === "*" && s[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return { text: out, applied: changed ? "comments" : null };
}

function replacePythonLiterals(s) {
  const t = s.replace(/(^|[^A-Za-z0-9_"'])(True|False|None)(?![A-Za-z0-9_])/g,
    (m, p, kw) => p + (kw === "True" ? "true" : kw === "False" ? "false" : "null"));
  return { text: t, applied: t !== s ? "python-literals" : null };
}

function fixSingleQuotes(s) {
  let out = "", inDouble = false, inSingle = false, esc = false, changed = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inDouble) {
      out += c;
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inDouble = false;
      continue;
    }
    if (inSingle) {
      if (esc) { out += c; esc = false; continue; }
      if (c === "\\") { out += c; esc = true; continue; }
      if (c === "'") { out += '"'; inSingle = false; continue; }
      out += (c === '"') ? '\\"' : c;
      continue;
    }
    if (c === '"') { inDouble = true; out += c; continue; }
    if (c === "'") { inSingle = true; changed = true; out += '"'; continue; }
    out += c;
  }
  return { text: out, applied: changed ? "single-quotes" : null };
}

function quoteUnquotedKeys(s) {
  const t = s.replace(/([{,]\s*)([A-Za-z_$][A-Za-z0-9_$]*)(\s*:)/g, '$1"$2"$3');
  return { text: t, applied: t !== s ? "unquoted-keys" : null };
}

function removeTrailingCommas(s) {
  let out = "", i = 0, inStr = false, esc = false, changed = false;
  while (i < s.length) {
    const c = s[i];
    if (inStr) {
      out += c;
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      i++;
      continue;
    }
    if (c === '"') { inStr = true; out += c; i++; continue; }
    if (c === ",") {
      let j = i + 1;
      while (j < s.length && /\s/.test(s[j])) j++;
      if (j < s.length && (s[j] === "}" || s[j] === "]")) { changed = true; i++; continue; }
    }
    out += c;
    i++;
  }
  return { text: out, applied: changed ? "trailing-commas" : null };
}

function balanceStructure(s) {
  let stack = [], inStr = false, esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{" || c === "[") stack.push(c);
    else if (c === "}" || c === "]") stack.pop();
  }
  let t = s;
  let changed = false;
  if (inStr) { t += '"'; changed = true; }
  t = t.replace(/,(\s*)$/, "");
  while (stack.length) {
    const open = stack.pop();
    t += open === "{" ? "}" : "]";
    changed = true;
  }
  return { text: t, applied: changed ? "balance" : null };
}

function repairJson(input) {
  const applied = [];
  if (typeof input !== "string") {
    return { ok: false, error: "input must be a string", repaired: null, applied };
  }
  let s = input.trim();
  const direct = tryParse(s);
  if (direct.ok) return { ok: true, repaired: direct.value, applied };

  const steps = [stripFences, extractJsonRegion, stripComments, replacePythonLiterals,
    quoteUnquotedKeys, fixSingleQuotes, removeTrailingCommas];
  let cur = s;
  for (const step of steps) {
    const r = step(cur);
    if (r.applied) applied.push(r.applied);
    cur = r.text;
  }
  let attempt = tryParse(cur);
  if (!attempt.ok) {
    const b = balanceStructure(cur);
    if (b.applied) {
      applied.push(b.applied);
      attempt = tryParse(b.text);
      cur = b.text;
    }
  }
  if (attempt.ok) return { ok: true, repaired: attempt.value, applied };
  return { ok: false, error: attempt.error, repaired: null, applied };
}
`;

// Exported so the equivalence test can pull out exactly what the browser runs.
export const CLIENT_REPAIR_SOURCE = CLIENT_REPAIR;

const UI_SCRIPT = String.raw`
const PASS_COPY = {
  "fences": ["stripFences", "Removed the Markdown code fence wrapped around the payload."],
  "prose-extract": ["extractJsonRegion", "Pulled the JSON out of the prose the model wrote around it."],
  "unclosed-extract": ["extractJsonRegion", "Found where the JSON started, but it never closed — salvaged from there on."],
  "comments": ["stripComments", "Deleted // and /* */ comments, which JSON does not allow."],
  "python-literals": ["replacePythonLiterals", "Rewrote Python's True / False / None as true / false / null."],
  "unquoted-keys": ["quoteUnquotedKeys", "Put double quotes around bare object keys."],
  "single-quotes": ["fixSingleQuotes", "Converted 'single-quoted' strings to \"double-quoted\", escaping any quotes inside."],
  "trailing-commas": ["removeTrailingCommas", "Dropped the commas left dangling before a closing brace or bracket."],
  "balance": ["balanceStructure", "Closed the brackets and strings the output was cut off before finishing."]
};

const FENCE = "` + "```" + String.raw`";

const SAMPLES = {
  fenced: "Sure! Here's the config you asked for:\n\n" + FENCE + "json\n{\n  service: 'checkout-api',\n  replicas: 3,\n  flags: ['retry', 'trace',],\n}\n" + FENCE + "\n\nLet me know if you want me to adjust anything.",
  python: '{\n  "name": "batch-runner",\n  "enabled": True,\n  "dry_run": False,\n  "last_error": None,\n  "retries": 5\n}',
  truncated: '{\n  "id": "usr_8812",\n  "email": "dev@example.com",\n  "roles": ["admin", "billing"],\n  "note": "cut off mid-sent',
  commented: '{\n  // the port the gateway binds to\n  "port": 8080,\n  /* upstreams are tried in order */\n  "upstreams": [\n    "10.0.0.4:9000",\n    "10.0.0.5:9000",\n  ],\n  "tls": True\n}',
  hopeless: '{ "totals": [1, 2, 3 "missing_comma": true }'
};

const inputEl = document.getElementById("input");
const outputEl = document.getElementById("output");
const verdictEl = document.getElementById("verdict");
const verdictText = document.getElementById("verdict-text");
const inMeta = document.getElementById("in-meta");
const logBody = document.getElementById("log-body");
const logCount = document.getElementById("log-count");
const copyBtn = document.getElementById("copy");

function plural(n, word) { return n + " " + word + (n === 1 ? "" : "s"); }

function render() {
  const raw = inputEl.value;
  inMeta.textContent = plural(raw.length, "char");

  if (!raw.trim()) {
    outputEl.textContent = "";
    outputEl.removeAttribute("data-state");
    verdictEl.setAttribute("data-state", "");
    verdictText.textContent = "Waiting";
    logCount.textContent = "";
    logBody.innerHTML = '<p class="log-empty">Paste something broken above, or load one of the samples. Each repair pass that fires gets listed here with the reason it was needed.</p>';
    return;
  }

  const result = repairJson(raw);

  if (result.ok) {
    outputEl.textContent = JSON.stringify(result.repaired, null, 2);
    outputEl.removeAttribute("data-state");
  } else {
    outputEl.textContent = "Could not repair.\n\nJSON.parse said:\n" + result.error;
    outputEl.setAttribute("data-state", "failed");
  }

  const n = result.applied.length;

  if (result.ok && n === 0) {
    verdictEl.setAttribute("data-state", "ok");
    verdictText.textContent = "Already valid";
  } else if (result.ok) {
    verdictEl.setAttribute("data-state", "fixed");
    verdictText.textContent = "Repaired · " + plural(n, "pass");
  } else {
    verdictEl.setAttribute("data-state", "failed");
    verdictText.textContent = "Beyond repair";
  }

  if (n === 0) {
    logCount.textContent = "";
    logBody.innerHTML = result.ok
      ? '<p class="log-empty">Nothing to do — this parsed on the first try with <code>JSON.parse</code>.</p>'
      : '<p class="log-empty">No pass could get a grip on this one. The structure is broken in a way that has more than one plausible fix, so guessing would risk changing your data.</p>';
    return;
  }

  logCount.textContent = n + " of 9 passes fired, in order";
  const ol = document.createElement("ol");
  ol.className = "repairs";
  result.applied.forEach(function (key) {
    const entry = PASS_COPY[key] || [key, ""];
    const li = document.createElement("li");
    const no = document.createElement("span");
    no.className = "step-no";
    const pass = document.createElement("span");
    pass.className = "pass";
    pass.textContent = entry[0];
    const why = document.createElement("span");
    why.className = "why";
    why.textContent = entry[1];
    li.appendChild(no);
    li.appendChild(pass);
    li.appendChild(why);
    ol.appendChild(li);
  });
  logBody.innerHTML = "";
  logBody.appendChild(ol);
}

inputEl.addEventListener("input", render);

document.querySelectorAll(".sample-btn").forEach(function (btn) {
  btn.addEventListener("click", function () {
    inputEl.value = SAMPLES[btn.dataset.sample];
    render();
    inputEl.focus();
    inputEl.setSelectionRange(0, 0);
    inputEl.scrollTop = 0;
  });
});

copyBtn.addEventListener("click", function () {
  const text = outputEl.textContent;
  if (!text) return;
  const done = function () {
    copyBtn.textContent = "Copied";
    copyBtn.setAttribute("data-copied", "yes");
    setTimeout(function () {
      copyBtn.textContent = "Copy";
      copyBtn.removeAttribute("data-copied");
    }, 1400);
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done, done);
  } else {
    done();
  }
});

inputEl.value = SAMPLES.fenced;
render();
`;

const STYLES = String.raw`
:root{--paper:#EAEEF4;--surface:#fff;--surface-sunk:#F4F6FA;--ink:#171C26;--muted:#616C7F;--line:#D3DAE5;--line-soft:#E4E9F1;--mark:#B96714;--mark-soft:#F6E7D3;--broken:#B23A30;--broken-soft:#F7E2DF;--ok:#256B4E;--ok-soft:#DCEDE4;--focus:#1F5FD0;--sans:'Archivo',ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif;--mono:'JetBrains Mono',ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--paper:#11141B;--surface:#191E28;--surface-sunk:#14181F;--ink:#E7EBF2;--muted:#8D99AD;--line:#2C3442;--line-soft:#232A36;--mark:#F0A44E;--mark-soft:#3A2A16;--broken:#E8786C;--broken-soft:#3A2220;--ok:#5FBE90;--ok-soft:#17301F;--focus:#6C9BF0}}
:root[data-theme="dark"]{--paper:#11141B;--surface:#191E28;--surface-sunk:#14181F;--ink:#E7EBF2;--muted:#8D99AD;--line:#2C3442;--line-soft:#232A36;--mark:#F0A44E;--mark-soft:#3A2A16;--broken:#E8786C;--broken-soft:#3A2220;--ok:#5FBE90;--ok-soft:#17301F;--focus:#6C9BF0}
*{box-sizing:border-box}
html,body{margin:0}
body{background:var(--paper);color:var(--ink);font-family:var(--sans);font-size:15px;line-height:1.5;-webkit-font-smoothing:antialiased}
.wrap{max-width:1140px;margin:0 auto;padding-inline:16px;padding-block:28px 56px}
.masthead{display:flex;flex-wrap:wrap;align-items:flex-end;gap:16px 24px;padding-bottom:18px;border-bottom:2px solid var(--ink);margin-bottom:22px}
.brand{flex:1 1 320px;min-width:0}
h1{font-size:clamp(28px,5vw,40px);line-height:1.05;letter-spacing:-.022em;font-weight:700;margin:0 0 8px;text-wrap:balance}
h1 .paren{color:var(--mark)}
.standfirst{margin:0;color:var(--muted);font-size:15px;max-width:58ch}
.verdict{flex:0 0 auto;display:flex;align-items:center;gap:10px;font-family:var(--mono);font-size:12px;font-weight:500;letter-spacing:.04em;text-transform:uppercase;padding:9px 14px;border-radius:2px;border:1px solid var(--line);background:var(--surface);color:var(--muted);white-space:nowrap}
.verdict .dot{width:8px;height:8px;border-radius:50%;background:var(--muted);flex:none}
.verdict[data-state="ok"]{color:var(--ok);border-color:var(--ok);background:var(--ok-soft)}
.verdict[data-state="ok"] .dot{background:var(--ok)}
.verdict[data-state="fixed"]{color:var(--mark);border-color:var(--mark);background:var(--mark-soft)}
.verdict[data-state="fixed"] .dot{background:var(--mark)}
.verdict[data-state="failed"]{color:var(--broken);border-color:var(--broken);background:var(--broken-soft)}
.verdict[data-state="failed"] .dot{background:var(--broken)}
.samples{display:flex;flex-wrap:wrap;align-items:baseline;gap:8px;margin-bottom:18px}
.samples-label{font-family:var(--mono);font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin-right:4px}
.sample-btn{font-family:var(--mono);font-size:12px;color:var(--ink);background:var(--surface);border:1px solid var(--line);border-radius:2px;padding:5px 10px;cursor:pointer;transition:border-color .12s,color .12s}
.sample-btn:hover{border-color:var(--mark);color:var(--mark)}
.sample-btn:focus-visible{outline:2px solid var(--focus);outline-offset:2px}
.benches{display:grid;grid-template-columns:1fr 1fr;gap:18px;align-items:start}
@media (max-width:800px){.benches{grid-template-columns:1fr}}
.bench{background:var(--surface);border:1px solid var(--line);border-radius:3px;display:flex;flex-direction:column;min-width:0;overflow:hidden}
.bench-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 14px;border-bottom:1px solid var(--line-soft);background:var(--surface-sunk)}
.bench-title{font-family:var(--mono);font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--muted)}
.bench-meta{font-family:var(--mono);font-size:11px;color:var(--muted);font-variant-numeric:tabular-nums}
textarea,.out{font-family:var(--mono);font-size:13px;line-height:1.65;tab-size:2;padding:14px;margin:0;border:0;min-height:300px;background:var(--surface);color:var(--ink);width:100%}
textarea{resize:vertical;outline:none;display:block}
textarea:focus-visible{box-shadow:inset 0 0 0 2px var(--focus)}
.out{white-space:pre;overflow-x:auto}
.out[data-state="failed"]{white-space:pre-wrap;color:var(--broken)}
.copy-btn{font-family:var(--mono);font-size:11px;letter-spacing:.04em;text-transform:uppercase;color:var(--muted);background:transparent;border:1px solid var(--line);border-radius:2px;padding:4px 9px;cursor:pointer;transition:color .12s,border-color .12s}
.copy-btn:hover{color:var(--mark);border-color:var(--mark)}
.copy-btn:focus-visible{outline:2px solid var(--focus);outline-offset:2px}
.copy-btn[data-copied="yes"]{color:var(--ok);border-color:var(--ok)}
.log{margin-top:22px;background:var(--surface);border:1px solid var(--line);border-radius:3px;overflow:hidden}
.log-head{padding:12px 16px;border-bottom:1px solid var(--line-soft);background:var(--surface-sunk);display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:8px}
.log-head h2{margin:0;font-size:13px;font-weight:700;letter-spacing:.02em}
.log-head p{margin:0;font-size:12px;color:var(--muted);font-family:var(--mono)}
ol.repairs{list-style:none;margin:0;padding:0;counter-reset:step}
ol.repairs li{display:grid;grid-template-columns:auto minmax(0,190px) minmax(0,1fr);gap:4px 14px;align-items:baseline;padding:11px 16px;border-bottom:1px solid var(--line-soft)}
ol.repairs li:last-child{border-bottom:0}
@media (max-width:620px){ol.repairs li{grid-template-columns:auto minmax(0,1fr)}ol.repairs li .why{grid-column:2/-1}}
.step-no{counter-increment:step;font-family:var(--mono);font-size:11px;color:var(--mark);font-variant-numeric:tabular-nums}
.step-no::before{content:counter(step,decimal-leading-zero)}
.pass{font-family:var(--mono);font-size:12.5px;font-weight:500;color:var(--ink);word-break:break-word}
.why{font-size:13.5px;color:var(--muted)}
.log-empty{padding:18px 16px;font-size:13.5px;color:var(--muted);margin:0}
.log-empty code{font-family:var(--mono);font-size:12.5px;background:var(--surface-sunk);border:1px solid var(--line-soft);border-radius:2px;padding:1px 5px}
.prose{margin-top:34px;padding-top:22px;border-top:1px solid var(--line);max-width:68ch}
.prose h2{font-size:19px;margin:0 0 10px;letter-spacing:-.01em}
.prose h3{font-size:15px;margin:20px 0 6px}
.prose p{margin:0 0 12px;color:var(--muted)}
.prose code{font-family:var(--mono);font-size:12.5px;background:var(--surface);border:1px solid var(--line-soft);border-radius:2px;padding:1px 5px;color:var(--ink)}
footer{margin-top:34px;padding-top:18px;border-top:1px solid var(--line);display:flex;flex-wrap:wrap;gap:14px 28px;justify-content:space-between;align-items:baseline;font-size:13px;color:var(--muted)}
footer p{margin:0;max-width:62ch}
footer a{color:var(--ink);text-decoration-color:var(--mark);text-underline-offset:3px}
footer a:focus-visible{outline:2px solid var(--focus);outline-offset:2px}
.privacy{font-family:var(--mono);font-size:11.5px;letter-spacing:.02em;color:var(--ok);white-space:nowrap}
@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
`;

const TITLE = "JSON Triage — repair broken JSON from an LLM";
const DESCRIPTION =
  "Paste malformed JSON from ChatGPT, Claude or any model and get it repaired in your browser. "
  + "Fixes code fences, trailing commas, single quotes, unquoted keys, Python True/False/None, "
  + "comments and truncated output — and names every repair it made. Free, no signup, nothing uploaded.";

// The origin is taken from the request rather than configuration, so the
// canonical URL, sitemap and social tags follow the page onto a custom domain
// without a redeploy. Pointing them at a different host than the one serving
// the page is what tells a search engine to ignore it.
export function renderPage(origin) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${TITLE}</title>
<meta name="description" content="${DESCRIPTION}">
<link rel="canonical" href="${origin}/">
<meta property="og:type" content="website">
<meta property="og:title" content="${TITLE}">
<meta property="og:description" content="${DESCRIPTION}">
<meta property="og:url" content="${origin}/">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${TITLE}">
<meta name="twitter:description" content="${DESCRIPTION}">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ctext y='.9em' font-size='90'%3E%F0%9F%A9%B9%3C/text%3E%3C/svg%3E">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;700&display=swap">
<script type="application/ld+json">
{"@context":"https://schema.org","@type":"WebApplication","name":"JSON Triage","url":"${origin}/","applicationCategory":"DeveloperApplication","operatingSystem":"Any","offers":{"@type":"Offer","price":"0","priceCurrency":"USD"},"description":"${DESCRIPTION}"}
</script>
<style>${STYLES}</style>
</head>
<body>
<div class="wrap">
  <header class="masthead">
    <div class="brand">
      <h1>JSON Triage<span class="paren">.</span></h1>
      <p class="standfirst">Paste the malformed JSON your model just handed you. It gets repaired here in your browser, and every repair is named.</p>
    </div>
    <div class="verdict" id="verdict" role="status" aria-live="polite">
      <span class="dot" aria-hidden="true"></span>
      <span id="verdict-text">Waiting</span>
    </div>
  </header>

  <div class="samples">
    <span class="samples-label">Try a broken one</span>
    <button class="sample-btn" type="button" data-sample="fenced">fenced + chatty</button>
    <button class="sample-btn" type="button" data-sample="python">python literals</button>
    <button class="sample-btn" type="button" data-sample="truncated">truncated mid-string</button>
    <button class="sample-btn" type="button" data-sample="commented">commented config</button>
    <button class="sample-btn" type="button" data-sample="hopeless">unrepairable</button>
  </div>

  <div class="benches">
    <section class="bench">
      <div class="bench-head">
        <span class="bench-title">Input</span>
        <span class="bench-meta" id="in-meta">0 chars</span>
      </div>
      <textarea id="input" spellcheck="false" autocapitalize="off" autocorrect="off" aria-label="Malformed JSON input"></textarea>
    </section>
    <section class="bench">
      <div class="bench-head">
        <span class="bench-title">Repaired</span>
        <button class="copy-btn" type="button" id="copy">Copy</button>
      </div>
      <pre class="out" id="output" tabindex="0" aria-label="Repaired JSON output"></pre>
    </section>
  </div>

  <section class="log">
    <div class="log-head">
      <h2>Repair log</h2>
      <p id="log-count"></p>
    </div>
    <div id="log-body"></div>
  </section>

  <section class="prose">
    <h2>Why LLM JSON breaks, and what gets fixed</h2>
    <p>A language model writes JSON as text, so it produces things a parser rejects: a Markdown code fence around the payload, a sentence before it, a trailing comma, keys without quotes, Python's <code>True</code> instead of <code>true</code>, or an answer that simply ran out of tokens halfway through a string.</p>
    <p>Nine passes run in a fixed order, each one narrow enough to be safe. Nothing is guessed: if a payload is broken in a way that has more than one plausible fix, it is reported as unrepairable rather than silently changed into something that parses but is wrong.</p>
    <h3>Does anything get uploaded?</h3>
    <p>No. The passes are compiled into this page and run in your tab. After the page loads, no request is made — you can disconnect and it still works.</p>
    <h3>Can I call this from a script?</h3>
    <p>Yes. The same passes are available as an HTTP API for agents and automation at <code>${PRICE}</code> per call, payable over x402 or MPP without an account or an API key. See <a href="/llms.txt">/llms.txt</a> for the full list of endpoints.</p>
  </section>

  <footer>
    <p>Deterministic repair passes from <a href="https://github.com/danielarif26/penniless-data-utilities" target="_blank" rel="noopener">penniless-data-utilities</a>, compiled into this page. No model is called, so the same input always gives the same output.</p>
    <span class="privacy">Nothing leaves your browser</span>
  </footer>
</div>
<script>
${CLIENT_REPAIR}
${UI_SCRIPT}
</script>
</body>
</html>
`;
}

export function renderRobots(origin) {
  return `User-agent: *
Allow: /

Sitemap: ${origin}/sitemap.xml
`;
}

export function renderSitemap(origin) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${origin}/</loc><changefreq>weekly</changefreq><priority>1.0</priority></url>
</urlset>
`;
}
