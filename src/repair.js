// Deterministic JSON repair for LLM output. No network, no deps.

function tryParse(s) {
  try {
    return { ok: true, value: JSON.parse(s) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function stripFences(s) {
  const m = s.match(/^\s*```(?:json|JSON)?\s*\n?([\s\S]*?)\n?\s*```\s*$/);
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
      if (esc) {
        out += c; // keep the escaped char as-is inside a double-quoted string
        esc = false;
        continue;
      }
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
      if (j < s.length && (s[j] === "}" || s[j] === "]")) {
        changed = true;
        i++;
        continue;
      }
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

export function repairJson(input) {
  const applied = [];
  if (typeof input !== "string") {
    return { ok: false, error: "input must be a string", repaired: null, applied };
  }
  let s = input.trim();
  const direct = tryParse(s);
  if (direct.ok) {
    return { ok: true, repaired: direct.value, applied };
  }
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
  if (attempt.ok) {
    return { ok: true, repaired: attempt.value, applied };
  }
  return { ok: false, error: attempt.error, repaired: null, applied };
}
