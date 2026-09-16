import test from "node:test";
import assert from "node:assert/strict";
import { repairJson } from "../src/repair.js";

test("valid JSON passes through untouched", () => {
  const r = repairJson('{"a":1,"b":[1,2,3]}');
  assert.equal(r.ok, true);
  assert.deepEqual(r.repaired, { a: 1, b: [1, 2, 3] });
  assert.deepEqual(r.applied, []);
});

test("markdown fences", () => {
  const r = repairJson('```json\n{"a": 1}\n```');
  assert.equal(r.ok, true);
  assert.deepEqual(r.repaired, { a: 1 });
  assert.ok(r.applied.includes("fences"));
});

test("trailing text after JSON", () => {
  const r = repairJson('{"a": 1} Hope this helps!');
  assert.equal(r.ok, true);
  assert.deepEqual(r.repaired, { a: 1 });
  assert.ok(r.applied.includes("prose-extract"));
});

test("leading prose before JSON", () => {
  const r = repairJson('Sure, here you go: {"a": [1,2]} let me know');
  assert.equal(r.ok, true);
  assert.deepEqual(r.repaired, { a: [1, 2] });
});

test("trailing comma in object", () => {
  const r = repairJson('{"a": 1, "b": 2,}');
  assert.equal(r.ok, true);
  assert.deepEqual(r.repaired, { a: 1, b: 2 });
  assert.ok(r.applied.includes("trailing-commas"));
});

test("trailing comma in array", () => {
  const r = repairJson('[1, 2, 3,]');
  assert.equal(r.ok, true);
  assert.deepEqual(r.repaired, [1, 2, 3]);
});

test("python literals", () => {
  const r = repairJson('{"ok": True, "bad": False, "none": None}');
  assert.equal(r.ok, true);
  assert.deepEqual(r.repaired, { ok: true, bad: false, none: null });
  assert.ok(r.applied.includes("python-literals"));
});

test("unquoted keys", () => {
  const r = repairJson('{name: "x", age: 3}');
  assert.equal(r.ok, true);
  assert.deepEqual(r.repaired, { name: "x", age: 3 });
  assert.ok(r.applied.includes("unquoted-keys"));
});

test("single-quoted strings", () => {
  const r = repairJson("{'name': 'Alice', 'age': 30}");
  assert.equal(r.ok, true);
  assert.deepEqual(r.repaired, { name: "Alice", age: 30 });
});

test("line comments", () => {
  const r = repairJson('{\n "a": 1, // one\n "b": 2\n}');
  assert.equal(r.ok, true);
  assert.deepEqual(r.repaired, { a: 1, b: 2 });
  assert.ok(r.applied.includes("comments"));
});

test("block comments", () => {
  const r = repairJson('{/* note */ "a": 1}');
  assert.equal(r.ok, true);
  assert.deepEqual(r.repaired, { a: 1 });
});

test("unclosed object is balanced", () => {
  const r = repairJson('{"a": {"b": [1, 2');
  assert.equal(r.ok, true);
  assert.deepEqual(r.repaired, { a: { b: [1, 2] } });
  assert.ok(r.applied.includes("balance"));
});

test("truncated mid-string", () => {
  const r = repairJson('{"title": "hello wor');
  assert.equal(r.ok, true);
  assert.deepEqual(r.repaired, { title: "hello wor" });
});

test("combined real-world failure: fence + python + trailing comma + prose", () => {
  const input = '```json\n{\n  Result: True,\n  items: [1, 2, 3,],\n}\n```\n\nLet me know if you need changes!';
  const r = repairJson(input);
  assert.equal(r.ok, true, `failed: ${r.error} applied=${r.applied}`);
  assert.deepEqual(r.repaired, { Result: true, items: [1, 2, 3] });
});

test("comment-like sequences inside strings are preserved", () => {
  const r = repairJson('{"url": "https://example.com/a//b", "c": 1}');
  assert.equal(r.ok, true);
  assert.deepEqual(r.repaired, { url: "https://example.com/a//b", c: 1 });
});

test("double quotes inside single-quoted string get escaped", () => {
  const r = repairJson("{'msg': 'say \"hi\"'}");
  assert.equal(r.ok, true);
  assert.deepEqual(r.repaired, { msg: 'say "hi"' });
});

test("genuinely unrepairable input fails cleanly", () => {
  const r = repairJson('not json at all, no braces');
  assert.equal(r.ok, false);
  assert.equal(r.repaired, null);
  assert.equal(typeof r.error, "string");
});

test("empty string fails cleanly", () => {
  const r = repairJson("");
  assert.equal(r.ok, false);
});

test("non-string input rejected", () => {
  const r = repairJson(42);
  assert.equal(r.ok, false);
});

test("array at top level with fences and trailing commas", () => {
  const r = repairJson('```\n[{"x":1,},{"x":2,}]\n```');
  assert.equal(r.ok, true);
  assert.deepEqual(r.repaired, [{ x: 1 }, { x: 2 }]);
});

test("nested structure survives quote fixing", () => {
  const r = repairJson("{a: {b: ['x', 'y']}}");
  assert.equal(r.ok, true);
  assert.deepEqual(r.repaired, { a: { b: ["x", "y"] } });
});

test("escaped backslash at end of string not mangled", () => {
  const r = repairJson('{"path": "C:\\\\dir\\\\"}');
  assert.equal(r.ok, true);
  assert.equal(r.repaired.path, "C:\\dir\\");
});

test("idempotent: repairing repaired output adds nothing", () => {
  const first = repairJson('{name: "x",}');
  assert.equal(first.ok, true);
  const second = repairJson(JSON.stringify(first.repaired));
  assert.equal(second.ok, true);
  assert.deepEqual(second.applied, []);
});


test("single-quoted URL/comment markers are data, not comments", () => {
  const r = repairJson("{url:'http://example.com/a', text:'not // a comment', block:'not /* comment */ either'}");
  assert.equal(r.ok, true);
  assert.deepEqual(r.repaired, {
    url: "http://example.com/a",
    text: "not // a comment",
    block: "not /* comment */ either",
  });
});

test("escaped apostrophe in a single-quoted pseudo-JSON string is repaired", () => {
  const r = repairJson("{text:'it\\'s ok'}");
  assert.equal(r.ok, true);
  assert.equal(r.repaired.text, "it's ok");
});

test("JSON region extraction ignores closing braces inside single-quoted strings", () => {
  const r = repairJson("prefix {text:'} stays data', n:1} suffix");
  assert.equal(r.ok, true);
  assert.deepEqual(r.repaired, { text: "} stays data", n: 1 });
});
