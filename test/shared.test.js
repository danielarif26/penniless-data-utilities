import test from "node:test";
import assert from "node:assert/strict";
import { TOOLS, validateArgs, MAX_INPUT, PRICE_ATOMIC } from "../src/shared.js";

// index.js and mcp.js now share one catalogue. These tests pin the validation
// contract that the rewritten HTTP routes depend on, since a successful paid
// REST call cannot be re-verified live without wallet balance.
test("every tool declares a usable schema and handler", () => {
  for (const [path, t] of Object.entries(TOOLS)) {
    assert.ok(t.mcpName && !t.mcpName.includes("/"), `${path} needs an MCP-safe name`);
    assert.equal(t.schema.type, "object");
    assert.ok(Array.isArray(t.schema.required) && t.schema.required.length >= 1);
    assert.ok(Object.keys(t.schema.properties).length >= 1);
    assert.equal(typeof t.handler, "function");
    for (const key of t.schema.required) {
      assert.ok(t.schema.properties[key], `${path} required '${key}' is not a declared property`);
    }
  }
});

test("mcp names are unique", () => {
  const names = Object.values(TOOLS).map((t) => t.mcpName);
  assert.equal(new Set(names).size, names.length);
});

test("validateArgs mirrors the previous per-route checks", () => {
  const s = TOOLS["/repair/json"].schema;
  assert.equal(validateArgs(s, { input: "x" }), null);
  assert.match(validateArgs(s, {}), /required/);
  assert.match(validateArgs(s, { input: 5 }), /must be a string/);
  assert.match(validateArgs(s, { input: "x".repeat(MAX_INPUT + 1) }), /maxBytes/);
  assert.match(validateArgs(s, null), /must be a JSON object/);
  assert.match(validateArgs(s, ["x"]), /must be a JSON object/);
});

test("dns type enum is case-insensitive on both surfaces", () => {
  const s = TOOLS["/dns/lookup"].schema;
  for (const t of ["MX", "mx", "Txt"]) {
    assert.equal(validateArgs(s, { domain: "example.com", type: t }), null, t);
  }
  assert.match(validateArgs(s, { domain: "example.com", type: "BOGUS" }), /must be one of/);
});

test("numeric and boolean options are type-checked", () => {
  assert.equal(validateArgs(TOOLS["/diff"].schema, { old: "a", new: "b", context: 5 }), null);
  assert.match(validateArgs(TOOLS["/diff"].schema, { old: "a", new: "b", context: "5" }), /must be a number/);
  assert.match(validateArgs(TOOLS["/text/extract"].schema, { input: "a", numbers: "yes" }), /must be a boolean/);
});

test("optional args may be omitted or null", () => {
  assert.equal(validateArgs(TOOLS["/cron/nextrun"].schema, { expr: "* * * * *" }), null);
  assert.equal(validateArgs(TOOLS["/cron/nextrun"].schema, { expr: "* * * * *", after: null }), null);
});

test("mcp price is the atomic USDC form of the advertised price", () => {
  assert.equal(PRICE_ATOMIC, "1000");
});
