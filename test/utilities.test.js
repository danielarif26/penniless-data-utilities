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

test("yaml invalid syntax returns an error instead of a paid partial result", () => {
  const r = yamlToValue("a: [1, 2\n");
  assert.equal(r.ok, false);
  assert.equal(r.value, null);
  assert.match(r.error, /invalid YAML/);
});

test("yaml empty or comment-only input remains an empty document", () => {
  const r = yamlToValue("# comment\n---\n\n");
  assert.equal(r.ok, true);
  assert.equal(r.value, null);
});

test("yaml preserves hash characters inside quoted and URL scalar values", () => {
  const r = yamlToValue('title: "hello # world"\nurl: https://example.com/a#frag\n');
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, { title: "hello # world", url: "https://example.com/a#frag" });
});

test("yaml single quotes use YAML doubled-apostrophe escaping", () => {
  const r = yamlToValue("title: 'it''s ok'\n");
  assert.equal(r.ok, true);
  assert.equal(r.value.title, "it's ok");
});

test("yaml supports indentless nested sequences and empty collections", () => {
  const r = yamlToValue("items:\n- 1\n- 2\nemptyMap: {}\nemptyList: []\n");
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, { items: [1, 2], emptyMap: {}, emptyList: [] });
});

test("yaml supports nested sequences and top-level scalars", () => {
  const nested = yamlToValue("- plain\n- - 1\n  - true\n");
  assert.equal(nested.ok, true);
  assert.deepEqual(nested.value, ["plain", [1, true]]);
  const scalar = yamlToValue("scalar only\n");
  assert.equal(scalar.ok, true);
  assert.equal(scalar.value, "scalar only");
});

test("yaml rejects duplicate keys", () => {
  const r = yamlToValue("a: 1\na: 2\n");
  assert.equal(r.ok, false);
  assert.match(r.error, /Map keys must be unique|duplicate/i);
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

test("cron supports month names and month-name ranges", () => {
  const jan = cronNextRun("0 0 1 JAN *", "2026-12-31T23:59:00Z");
  assert.equal(jan.ok, true);
  assert.equal(jan.next, "2027-01-01T00:00:00.000Z");
  const range = cronNextRun("0 0 1 JAN-MAR *", "2026-12-31T23:59:00Z");
  assert.equal(range.ok, true);
  assert.equal(range.next, "2027-01-01T00:00:00.000Z");
});

test("cron accepts 7 as Sunday", () => {
  const r = cronNextRun("0 0 * * 7", "2026-09-12T00:00:00Z");
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

test("diff treats an empty document as zero lines", () => {
  const add = diffLines("", "a");
  assert.equal(add.added, 1);
  assert.equal(add.removed, 0);
  assert.match(add.unified, /@@ -0,0 \+1,1 @@/);
  const remove = diffLines("a", "");
  assert.equal(remove.added, 0);
  assert.equal(remove.removed, 1);
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

test("extract ignores invalid numeric entities safely", () => {
  const r = extract("<p>&#9999999999;</p>");
  assert.equal(r.ok, true);
  assert.match(r.text, /&#9999999999;/);
});

test("extract codeBlocks option captures HTML pre/code and stays opt-in", () => {
  const html = "<pre><code>let x=1;</code></pre>";
  const withBlocks = extract(html, { codeBlocks: true });
  assert.ok(withBlocks.codeBlocks.includes("let x=1;"));
  const withoutBlocks = extract(html, { codeBlocks: false });
  assert.equal(Object.hasOwn(withoutBlocks, "codeBlocks"), false);
});

test("extract strips script/style", () => {
  const r = extract("<script>var x=1;</script><style>.a{}</style><p>visible &lt;text&gt;</p>");
  assert.match(r.text, /visible <text>/);
  assert.doesNotMatch(r.text, /var x/);
});
