// Dependency-free line diff (Myers-style LCS over lines) with unified output.

function lcsTable(a, b) {
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  return dp;
}

function buildOps(a, b) {
  const dp = lcsTable(a, b);
  const ops = [];
  let i = 0;
  let j = 0;
  let ln = 0;
  let rn = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push({ op: " ", old: ++ln, new: ++rn, text: a[i] });
      i++; j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ op: "-", old: ++ln, new: null, text: a[i++] });
    } else {
      ops.push({ op: "+", old: null, new: ++rn, text: b[j++] });
    }
  }
  while (i < a.length) ops.push({ op: "-", old: ++ln, new: null, text: a[i++] });
  while (j < b.length) ops.push({ op: "+", old: null, new: ++rn, text: b[j++] });
  return ops;
}

// Group changed ops with `ctx` lines of context, merging nearby groups.
function hunkRanges(ops, ctx) {
  const changed = [];
  for (let k = 0; k < ops.length; k++) if (ops[k].op !== " ") changed.push(k);
  if (!changed.length) return [];
  const ranges = [];
  let s = Math.max(0, changed[0] - ctx);
  let e = Math.min(ops.length - 1, changed[0] + ctx);
  for (const c of changed.slice(1)) {
    if (c - ctx <= e + 1) {
      e = Math.min(ops.length - 1, c + ctx);
    } else {
      ranges.push([s, e]);
      s = Math.max(0, c - ctx);
      e = Math.min(ops.length - 1, c + ctx);
    }
  }
  ranges.push([s, e]);
  return ranges;
}

export function diffLines(oldText, newText, ctx = 3) {
  const a = String(oldText).replace(/\r\n?/g, "\n").split("\n");
  const b = String(newText).replace(/\r\n?/g, "\n").split("\n");
  if (a.length * b.length > 1_000_000) {
    return { ok: false, error: "input too large for diff (limit ~1M line-pairs)" };
  }
  const ops = buildOps(a, b);
  const added = ops.filter((o) => o.op === "+").length;
  const removed = ops.filter((o) => o.op === "-").length;
  const identical = added === 0 && removed === 0;

  const lines = [];
  const hunks = [];
  for (const [s, e] of hunkRanges(ops, Math.max(0, Math.min(20, ctx | 0)))) {
    const slice = ops.slice(s, e + 1);
    const oldStart = slice.find((o) => o.old !== null)?.old ?? 0;
    const newStart = slice.find((o) => o.new !== null)?.new ?? 0;
    const oldCount = slice.filter((o) => o.op !== "+").length;
    const newCount = slice.filter((o) => o.op !== "-").length;
    const header = `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`;
    lines.push(header);
    for (const o of slice) lines.push(o.op + o.text);
    hunks.push({ header, oldStart, newStart, oldCount, newCount });
  }

  return {
    ok: true,
    identical,
    added,
    removed,
    hunks,
    unified: identical ? "" : lines.join("\n"),
  };
}
