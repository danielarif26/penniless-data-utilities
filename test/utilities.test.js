import test from "node:test";
import assert from "node:assert/strict";
import { yamlToValue } from "../src/yaml.js";
import { cronNextRun } from "../src/cron.js";
import { diffLines } from "../src/diff.js";
import { extract } from "../src/extract.js";

// --- yaml ---
test("yaml flat map", () => {
  const r = yamlToValue("name: web\nport: 8080\ntls: true\nempty: null\n");
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, { name: "web", port: 8080, tls: true, empty: null });
});

test("yaml nested map and sequence", () => {
  const r = yamlToValue("name: web\nports:\n  - 80\n  - 443\ndb:\n  host: localhost\n  tls: true\n");
  assert.deepEqual(r.value, { name: "web", ports: [80, 443], db: { host: "localhost", tls: true } });
});

test("yaml quoted strings and comments", () => {
  const r = yamlToValue("# a comment\ntitle: 'hello: world'\nsub: \"x\"  # trailing\n");
  assert.equal(r.value.title, "hello: world");
  assert.equal(r.value.sub, "x");
});

test("yaml sequence of maps", () => {
  const r = yamlToValue("items:\n  - name: a\n    id: 1\n  - name: b\n    id: 2\n");
  assert.deepEqual(r.value, { items: [{ name: "a", id: 1 }, { name: "b", id: 2 }] });
});

// --- cron ---
test("cron simple every-15-min", () => {
  const r = cronNextRun("*/15 * * * *", "2026-09-14T10:03:00Z");
  assert.equal(r.ok, true);
  assert.equal(r.next, "2026-09-14T10:15:00.000Z");
});

test("cron weekday business hours", () => {
  const r = cronNextRun("*/15 9-17 * * MON-FRI", "2026-09-14T00:00:00Z");
  assert.equal(r.ok, true);
  assert.equal(r.next, "2026-09-14T09:00:00.000Z");
});

test("cron dom+dow restricted uses OR semantics", () => {
  // 13th OR Friday. From 2026-09-11, the 13th (Sun) comes before Friday the 18th.
  const r = cronNextRun("0 0 13 * 5", "2026-09-11T00:00:00Z");
  assert.equal(r.ok, true);
  assert.equal(r.next, "2026-09-13T00:00:00.000Z");
});

test("cron rejects bad expression", () => {
  assert.equal(cronNextRun("* * *", null).ok, false);
  assert.equal(cronNextRun("99 * * * *", null).ok, false);
});

// --- diff ---
test("diff one-line change", () => {
  const r = diffLines("a\nb\nc", "a\nB\nc");
  assert.equal(r.ok, true);
  assert.equal(r.added, 1);
  assert.equal(r.removed, 1);
  assert.equal(r.identical, false);
  assert.match(r.unified, /@@ -1,3 \+1,3 @@/);
});

test("diff identical inputs", () => {
  const r = diffLines("x\ny", "x\ny");
  assert.equal(r.identical, true);
  assert.equal(r.unified, "");
});

test("diff pure addition", () => {
  const r = diffLines("a\nb", "a\nnew\nb");
  assert.equal(r.added, 1);
  assert.equal(r.removed, 0);
});

// --- extract ---
test("extract html title, headings, links, emails", () => {
  const html = "<title>Page &amp; Title</title><h1>Head</h1><p>mail me at bob@corp.io or <a href='/x'>X</a> and https://full.dev/p</p>";
  const r = extract(html);
  assert.equal(r.source, "html");
  assert.equal(r.title, "Page & Title");
  assert.deepEqual(r.headings, [{ level: 1, text: "Head" }]);
  assert.deepEqual(r.links, [{ href: "/x", text: "X" }]);
  assert.deepEqual(r.urls, ["https://full.dev/p"]);
  assert.deepEqual(r.emails, ["bob@corp.io"]);
});

test("extract plain text urls and numbers", () => {
  const r = extract("reach us at hi@ex.com, cost $1,200.50 see https://a.b/c", { numbers: true });
  assert.equal(r.source, "text");
  assert.deepEqual(r.emails, ["hi@ex.com"]);
  assert.deepEqual(r.urls, ["https://a.b/c"]);
  assert.ok(r.numbers.includes("1,200.50"));
});

test("extract strips script/style", () => {
  const r = extract("<script>var x=1;</script><style>.a{}</style><p>visible &lt;text&gt;</p>");
  assert.match(r.text, /visible <text>/);
  assert.doesNotMatch(r.text, /var x/);
});
