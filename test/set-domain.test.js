import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { applyDomain, normalizeHost } from "../scripts/set-domain.mjs";

const CONFIG = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");

test("a domain is accepted however someone happens to paste it", () => {
  for (const written of [
    "json.example.com", "  json.example.com  ", "JSON.Example.COM",
    "https://json.example.com", "https://json.example.com/", "json.example.com.",
    "http://json.example.com/some/path",
  ]) {
    assert.equal(normalizeHost(written).host, "json.example.com", `accepts ${JSON.stringify(written)}`);
  }
});

test("things that are not a domain are refused with a reason, not a stack trace", () => {
  const rejected = ["", "   ", undefined, "not a domain", "me@example.com", "example.com:8080", "localhost", "example"];
  for (const written of rejected) {
    const result = normalizeHost(written);
    assert.equal(result.host, undefined, `${JSON.stringify(written)} must be refused`);
    assert.match(result.error, /\w/, "and must say why");
  }
});

test("the workers.dev address is refused, since it already works", () => {
  const result = normalizeHost("penniless-json-repair.sjaman.workers.dev");
  assert.equal(result.host, undefined);
  assert.match(result.error, /domain you own/);
});

test("applying a domain writes the route, the canonical host and keeps workers.dev", () => {
  const next = applyDomain(CONFIG, "json.example.com");
  assert.match(next, /routes = \[\n  \{ pattern = "json\.example\.com", custom_domain = true \}\n\]/);
  assert.match(next, /^CANONICAL_HOST = "json\.example\.com"$/m);
  assert.match(next, /^workers_dev = true$/m);
  // The paid API is advertised on workers.dev and referenced by two directory
  // listings, so the subdomain must not be retired by adding a route.
  assert.doesNotMatch(next, /workers_dev = false/);
});

test("top-level keys land above the first table, where TOML requires them", () => {
  const next = applyDomain(CONFIG, "json.example.com");
  const firstTable = next.search(/^\[/m);
  assert.ok(next.slice(0, firstTable).includes("routes = ["), "routes precedes the first table");
  assert.ok(next.slice(0, firstTable).includes("workers_dev = true"), "workers_dev precedes the first table");
  // CANONICAL_HOST is a var, so it belongs inside [vars] instead.
  const vars = next.slice(next.indexOf("[vars]"));
  assert.match(vars, /^CANONICAL_HOST = "json\.example\.com"$/m);
});

test("nothing essential is lost, and the commented placeholder is replaced not duplicated", () => {
  const next = applyDomain(CONFIG, "json.example.com");
  for (const kept of ['name = "penniless-json-repair"', 'main = "src/entry.js"', "[[d1_databases]]", "[vars]",
    'X402_PAY_TO = "0x3D98800c64C345950E1eAaa076D88C12d1BF5F37"']) {
    assert.ok(next.includes(kept), `must keep ${kept}`);
  }
  assert.equal(next.match(/^CANONICAL_HOST/gm)?.length, 1, "exactly one CANONICAL_HOST");
  assert.doesNotMatch(next, /^#\s*CANONICAL_HOST/m, "the placeholder comment is consumed");
});

test("changing your mind replaces the domain instead of stacking a second one", () => {
  const once = applyDomain(CONFIG, "json.example.com");
  const twice = applyDomain(once, "tools.example.org");
  assert.equal(twice.match(/pattern =/g)?.length, 1, "one route only");
  assert.equal(twice.match(/^CANONICAL_HOST/gm)?.length, 1, "one canonical host only");
  assert.equal(twice.match(/^workers_dev/gm)?.length, 1, "one workers_dev only");
  assert.match(twice, /pattern = "tools\.example\.org"/);
  assert.doesNotMatch(twice, /json\.example\.com/);
  assert.equal(applyDomain(twice, "tools.example.org"), twice, "and re-running is a no-op");
});
