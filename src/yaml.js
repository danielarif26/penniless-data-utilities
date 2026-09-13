// Dependency-free converters for common machine-data shapes.

const MAP_RE = /^([^\s:][^:]*?):(?:[ \t]+([^#]*?))?[ \t]*$/;

// Returns a row for `rest` at column `col`, or null if unparseable.
function rowFromRest(rest, col, line) {
  const noComment = rest.replace(/\s+#.*$/, "").trimEnd();
  if (noComment === "") return null;
  const mm = MAP_RE.exec(noComment);
  if (mm) {
    return { kind: "map", indent: col, key: mm[1].trim(), value: mm[2] !== undefined && mm[2] !== "" ? mm[2].trim() : null, line };
  }
  return { kind: "scalar", indent: col, key: null, value: noComment, line };
}

export function yamlToValue(input) {
  const warnings = [];
  const lines = String(input).replace(/\r\n?/g, "\n").split("\n");

  const itemRe = /^([ \t]*)(?:-([ \t]+)([^#]*?)|([^\s:][^:]*?):(?:[ \t]+([^#]*?))?)(?:[ \t]+#.*)?[ \t]*$/;

  const rows = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();
    if (trimmed === "" || trimmed === "---" || trimmed.startsWith("#")) continue;

    const m = itemRe.exec(raw);
    if (!m) {
      warnings.push(`line ${i + 1}: unrecognized syntax, skipped`);
      continue;
    }
    const indent = m[1].length;
    if (m[2] !== undefined) {
      // sequence item; content after "- " may itself be an inline map
      const rest = (m[3] || "").trim();
      if (rest === "") {
        rows.push({ kind: "seq", indent, key: null, value: null, line: i + 1 });
      } else {
        const col = indent + 1 + m[2].length;
        const inline = rowFromRest(rest, col, i + 1);
        if (!inline) { warnings.push(`line ${i + 1}: bad sequence item, skipped`); continue; }
        if (inline.kind === "scalar") {
          rows.push({ kind: "seq", indent, key: null, value: inline.value, line: i + 1 });
        } else {
          rows.push({ kind: "seq", indent, key: null, value: null, line: i + 1 });
          rows.push(inline);
        }
      }
    } else if (m[4] !== undefined) {
      rows.push({ kind: "map", indent, key: m[4].trim(), value: m[5] !== undefined && m[5] !== "" ? m[5].trim() : null, line: i + 1 });
    } else {
      warnings.push(`line ${i + 1}: unrecognized syntax, skipped`);
    }
  }

  function parseScalar(s) {
    if (s === null || s === "") return null;
    if (/^(~|null)$/i.test(s)) return null;
    if (s === "true" || s === "True") return true;
    if (s === "false" || s === "False") return false;
    if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(s)) return Number(s);
    if ((s.startsWith('"') && s.endsWith('"') && s.length >= 2) || (s.startsWith("'") && s.endsWith("'") && s.length >= 2)) {
      return s.slice(1, -1).replace(/\\'/g, "'").replace(/\\\\/g, "\\").replace(/\\n/g, "\n");
    }
    return s;
  }

  function build(start, end, indent) {
    const isSeq = rows[start].kind === "seq";
    const container = isSeq ? [] : {};
    let i = start;
    while (i < end) {
      const row = rows[i];
      let j = i + 1;
      while (j < end && rows[j].indent > indent) j++;
      let value = row.value;
      if (j > i + 1) {
        value = build(i + 1, j, rows[i + 1].indent);
      } else if (typeof value === "string") {
        value = parseScalar(value);
      }
      if (isSeq) container.push(value);
      else container[row.key] = value;
      i = j;
    }
    return container;
  }

  if (rows.length === 0) return { ok: true, value: null, warnings };
  const base = Math.min(...rows.map((r) => r.indent));
  const value = build(0, rows.length, base);
  return { ok: true, value, warnings };
}
