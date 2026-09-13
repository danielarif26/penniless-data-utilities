// Dependency-free 5-field cron "next run" solver.

const MONTHS = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
const DOWS = { SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6 };

function parseField(field, min, max, names) {
  const set = new Set();
  for (const part of field.split(",")) {
    const m = /^([^-/]+|\*)(?:-(\d+|[A-Za-z]+))?(?:\/(\d+))?$/.exec(part.trim());
    if (!m) throw new Error(`bad cron field: ${field}`);
    let lo;
    let hi;
    const resolve = (tok) => {
      if (names && /^[A-Za-z]+$/.test(tok)) {
        const v = names[tok.toUpperCase()];
        if (v === undefined) throw new Error(`unknown cron name: ${tok}`);
        return v;
      }
      return Number(tok);
    };
    if (m[1] === "*") {
      lo = min;
      hi = max;
    } else {
      lo = resolve(m[1]);
      hi = m[2] !== undefined ? resolve(m[2]) : lo;
    }
    if (Number.isNaN(lo) || Number.isNaN(hi) || lo < min || hi > max || lo > hi) {
      throw new Error(`cron value out of range: ${part}`);
    }
    const step = m[3] !== undefined ? Number(m[3]) : 1;
    if (!Number.isInteger(step) || step < 1) throw new Error(`bad step: ${part}`);
    for (let v = lo; v <= hi; v += step) set.add(v);
  }
  return set;
}

export function cronNextRun(expr, afterIso) {
  const fields = String(expr).trim().split(/\s+/);
  if (fields.length !== 5) return { ok: false, error: "cron expression must have 5 fields (minute hour dom month dow)" };
  let minute, hour, dom, month, dow;
  try {
    minute = parseField(fields[0], 0, 59);
    hour = parseField(fields[1], 0, 23);
    dom = parseField(fields[2], 1, 31);
    month = parseField(fields[3], 1, 12, MONTHS);
    dow = parseField(fields[4], 0, 6, DOWS);
  } catch (e) {
    return { ok: false, error: e.message };
  }
  const domRestricted = fields[2] !== "*";
  const dowRestricted = fields[4] !== "*";

  let t;
  if (afterIso) {
    t = new Date(afterIso);
    if (Number.isNaN(t.getTime())) return { ok: false, error: "invalid 'after' timestamp" };
  } else {
    t = new Date();
  }
  t = new Date(Math.floor(t.getTime() / 60000) * 60000 + 60000);

  const limit = t.getTime() + 1000 * 60 * 60 * 24 * 366 * 4;
  while (t.getTime() < limit) {
    const domOk = !domRestricted || dom.has(t.getUTCDate());
    const dowOk = !dowRestricted || dow.has(t.getUTCDay());
    // Both restricted means OR, not AND — standard Vixie-cron day matching.
    const dayOk = domRestricted && dowRestricted ? domOk || dowOk : domOk && dowOk;
    if (!month.has(t.getUTCMonth() + 1) || !dayOk) {
      t = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate() + 1));
      continue;
    }
    if (!hour.has(t.getUTCHours())) {
      t = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate(), t.getUTCHours() + 1));
      continue;
    }
    if (!minute.has(t.getUTCMinutes())) {
      t = new Date(t.getTime() + 60000);
      continue;
    }
    return { ok: true, next: t.toISOString(), epochMs: t.getTime() };
  }
  return { ok: false, error: "no matching time within 4 years" };
}
