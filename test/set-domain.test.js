import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { applyDomain, clearDomain, normalizeHost } from "../scripts/set-domain.mjs";

const CONFIG = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
const HOST = "json.sjaman.dev";

test("a domain is accepted however someone happens to paste it", () => {
  for (const written of [
    HOST, `  ${HOST}  `, "JSON.Sjaman.DEV", `https://${HOST}`,
    `https://${HOST}/`, `${HOST}.`, `http://${HOST}/some/path`,
  ]) {
    assert.equal(normalizeHost(written).host, HOST, `accepts ${JSON.stringify(written)}`);
  }
});

test("things that are not a domain are refused with a reason, not a stack trace", () => {
  for (const written of ["", "   ", undefined, "not a domain", "me@sjaman.dev", "sjaman.dev:8080", "localhost", "sjaman"]) {
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

// This is the failure that actually happened: a placeholder was pasted, the
// route was refused by Cloudflare, but CANONICAL_HOST deployed anyway and the
// live page spent the next while naming someone else's domain as its own.
test("placeholder domains are refused before they can reach the config", () => {
  const placeholders = [
    "YOURDOMAIN.com", "yourdomain.com", "your-domain.com", "mydomain.com",
    "thedomain.com", "domain.com", "my-site.io", "thewebsite.net",
    "example.com", "example.org", "www.example.com", "sub.example.com",
    "deep.sub.example.net", "test.com", "foo.com", "mysite.com",
    "yoursite.com", "placeholder.com", "anything.localhost", "api.invalid",
  ];
  for (const written of placeholders) {
    const result = normalizeHost(written);
    assert.equal(result.host, undefined, `${written} must be refused`);
    assert.match(result.error, /placeholder|not a domain/i, `${written} must say why`);
  }
});

test("real domains are not caught by the placeholder guard", () => {
  for (const written of ["jsontools.dev", HOST, "repair-json.io", "a.co", "tools.arif.io", "json.example-tools.dev"]) {
    assert.equal(normalizeHost(written).host, written.toLowerCase(), `${written} must be accepted`);
  }
});

test("applying a domain writes the route, the canonical host and keeps workers.dev", () => {
  const next = applyDomain(CONFIG, HOST);
  assert.match(next, new RegExp(`routes = \\[\\n  \\{ pattern = "${HOST.replace(/\./g, "\\.")}", custom_domain = true \\}\\n\\]`));
  assert.match(next, new RegExp(`^CANONICAL_HOST = "${HOST.replace(/\./g, "\\.")}"$`, "m"));
  assert.match(next, /^workers_dev = true$/m);
  // The paid API is advertised on workers.dev and referenced by two directory
  // listings, so the subdomain must not be retired by adding a route.
  assert.doesNotMatch(next, /workers_dev = false/);
});

test("top-level keys land above the first table, where TOML requires them", () => {
  const next = applyDomain(CONFIG, HOST);
  const firstTable = next.search(/^\[/m);
  assert.ok(next.slice(0, firstTable).includes("routes = ["), "routes precedes the first table");
  assert.ok(next.slice(0, firstTable).includes("workers_dev = true"), "workers_dev precedes the first table");
  // CANONICAL_HOST is a var, so it belongs inside [vars] instead.
  assert.match(next.slice(next.indexOf("[vars]")), /^CANONICAL_HOST = /m);
});

test("nothing essential is lost, and the commented placeholder is replaced not duplicated", () => {
  const next = applyDomain(CONFIG, HOST);
  for (const kept of ['name = "penniless-json-repair"', 'main = "src/entry.js"', "[[d1_databases]]", "[vars]",
    'X402_PAY_TO = "0x3D98800c64C345950E1eAaa076D88C12d1BF5F37"']) {
    assert.ok(next.includes(kept), `must keep ${kept}`);
  }
  assert.equal(next.match(/^CANONICAL_HOST/gm)?.length, 1, "exactly one CANONICAL_HOST");
  assert.doesNotMatch(next, /^#\s*CANONICAL_HOST/m, "the placeholder comment is consumed");
});

test("changing your mind replaces the domain instead of stacking a second one", () => {
  const once = applyDomain(CONFIG, HOST);
  const twice = applyDomain(once, "tools.arif.io");
  assert.equal(twice.match(/pattern =/g)?.length, 1, "one route only");
  assert.equal(twice.match(/^CANONICAL_HOST/gm)?.length, 1, "one canonical host only");
  assert.equal(twice.match(/^workers_dev/gm)?.length, 1, "one workers_dev only");
  assert.match(twice, /pattern = "tools\.arif\.io"/);
  assert.doesNotMatch(twice, /json\.sjaman\.dev/);
  assert.equal(applyDomain(twice, "tools.arif.io"), twice, "and re-running is a no-op");
});

test("clearing takes the domain back out and restores the commented placeholder", () => {
  const cleared = clearDomain(applyDomain(CONFIG, HOST));

  assert.doesNotMatch(cleared, /^routes\s*=/m, "no route left");
  assert.doesNotMatch(cleared, /^workers_dev\s*=/m, "no workers_dev left");
  assert.doesNotMatch(cleared, /^CANONICAL_HOST\s*=/m, "no active canonical host left");
  assert.doesNotMatch(cleared, /json\.sjaman\.dev/, "the domain is gone entirely");
  assert.match(cleared, /^#\s*CANONICAL_HOST/m, "the placeholder comment comes back");

  // Everything that makes the Worker work has to survive an undo.
  for (const kept of ['name = "penniless-json-repair"', 'main = "src/entry.js"', "[[d1_databases]]", "[vars]",
    'X402_PAY_TO = "0x3D98800c64C345950E1eAaa076D88C12d1BF5F37"']) {
    assert.ok(cleared.includes(kept), `must keep ${kept}`);
  }
  assert.equal(clearDomain(cleared), cleared, "clearing twice changes nothing more");
});
