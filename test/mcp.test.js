import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { x402ResourceServer } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { createMcpHandler } from "../src/mcp.js";
import { TOOLS, NETWORK } from "../src/shared.js";

// Real scheme + resource server, stubbed facilitator client: requirement
// generation is local, so the test suite never touches the network.
const fakeResourceServer = new x402ResourceServer({
  getConfig: () => ({ url: "http://facilitator.invalid" }),
  initialize: async () => {},
  getSupported: async () => ({ kinds: [] }),
}).register(NETWORK, new ExactEvmScheme());

async function withClient(run) {
  const handle = createMcpHandler(fakeResourceServer);
  const serverApp = { fetch: (req) => handle(req) };
  const transport = new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
    fetch: (url, init) => serverApp.fetch(new Request(url, init)),
  });
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(transport);
  try {
    return await run(client);
  } finally {
    await client.close();
  }
}

test("mcp lists all ten tools with descriptions, prices, and source schemas", async () => {
  await withClient(async (client) => {
    const { tools } = await client.listTools();
    assert.equal(tools.length, Object.keys(TOOLS).length);
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, Object.values(TOOLS).map((t) => t.mcpName).sort());
    for (const tool of tools) {
      assert.ok(tool.description.includes("per call"), `${tool.name} should state pricing`);
      assert.equal(tool.inputSchema.type, "object");
      assert.ok(Array.isArray(tool.inputSchema.required) && tool.inputSchema.required.length > 0);
    }
    const repair = tools.find((t) => t.name === "repair_json");
    assert.ok(repair.inputSchema.properties.input);
    assert.match(repair.description, /\$0\.005/);
    const dns = tools.find((t) => t.name === "dns_lookup");
    assert.deepEqual(dns.inputSchema.properties.type.enum.slice(0, 3), ["A", "AAAA", "CNAME"]);
    assert.match(dns.description, /\$0\.02/);

    // This is a live MCP contract assertion: listTools() returns the schema
    // actually advertised by the transport, rather than an implementation
    // detail.  Any REST/source schema drift fails CI for every tool.
    for (const source of Object.values(TOOLS)) {
      const advertised = tools.find((tool) => tool.name === source.mcpName).inputSchema;
      assert.equal(advertised.type, source.schema.type, `${source.mcpName} root type`);
      assert.equal(advertised.additionalProperties, source.schema.additionalProperties, `${source.mcpName} additionalProperties`);
      assert.deepEqual(advertised.required ?? [], source.schema.required ?? [], `${source.mcpName} required fields`);
      for (const [name, spec] of Object.entries(source.schema.properties)) {
        const field = advertised.properties[name];
        assert.ok(field, `${source.mcpName}.${name} missing from MCP schema`);
        assert.equal(field.type, spec.type, `${source.mcpName}.${name} type`);
        assert.deepEqual(field.enum, spec.enum, `${source.mcpName}.${name} enum`);
        if (spec.items) {
          assert.equal(field.items?.type, spec.items.type, `${source.mcpName}.${name} item type`);
          assert.deepEqual(field.items?.enum, spec.items.enum, `${source.mcpName}.${name} item enum`);
        }
      }
    }
    const crypto = tools.find((t) => t.name === "crypto_price");
    assert.equal(crypto.inputSchema.properties.symbols.type, "array");
    assert.deepEqual(crypto.inputSchema.properties.symbols.items.enum, ["eth", "btc", "usdc", "sol"]);
  });
});

test("mcp tools/call returns a payment requirement when unpaid", async () => {
  await withClient(async (client) => {
    const res = await client.callTool({
      name: "repair_json",
      arguments: { input: "{foo: 1,}" },
    });
    assert.equal(res.isError, true);
    const payload = JSON.parse(res.content[0].text);
    assert.equal(payload.x402Version, 2);
    assert.equal(payload.accepts[0].scheme, "exact");
    assert.equal(payload.accepts[0].network, "eip155:8453");
    assert.equal(payload.accepts[0].amount, "5000");
    assert.equal(payload.accepts[0].asset, "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
  });
});

test("mcp is stateless: no session id is issued or required", async () => {
  const handle = createMcpHandler(fakeResourceServer);
  const init = await handle(new Request("http://localhost/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } },
    }),
  }));
  assert.equal(init.status, 200);
  assert.equal(init.headers.get("mcp-session-id"), null);
});

test("mcp paid tools/call runs the handler and returns structured output", async () => {
  // Only verification + settlement are faked; requirement matching, flow
  // resolution and the tool handler itself all run for real.
  const paid = Object.create(fakeResourceServer);
  let settleCalls = 0;
  paid.verifyPayment = async () => ({ isValid: true });
  paid.settlePayment = async () => { settleCalls += 1; return { success: true, result: { transaction: "0xtest", network: NETWORK } }; };

  const handle = createMcpHandler(paid);
  const transport = new StreamableHTTPClientTransport(new URL("http://localhost/mcp"), {
    fetch: (url, init) => handle(new Request(url, init)),
  });
  const client = new Client({ name: "payer", version: "1.0.0" });
  await client.connect(transport);
  try {
    // An x402 v2 payment payload echoes the requirement it satisfies, so take
    // the real one from an unpaid call instead of inventing it.
    const unpaid = JSON.parse((await client.callTool({
      name: "repair_json", arguments: { input: "{a: 1,}" },
    })).content[0].text);

    const res = await client.callTool({
      name: "repair_json",
      arguments: { input: "{foo: 'bar',}" },
      _meta: {
        "x402/payment": {
          x402Version: 2,
          accepted: unpaid.accepts[0],
          payload: { signature: "0xs", authorization: "0xa", clientAddress: "0xclient" },
        },
      },
    });
    assert.notEqual(res.isError, true, `paid call was not accepted: ${JSON.stringify(res).slice(0, 300)}`);
    assert.equal(res.structuredContent.ok, true);
    assert.deepEqual(res.structuredContent.repaired, { foo: "bar" });
    assert.equal(settleCalls, 1, "settlement must run exactly once for a paid call");
    assert.equal(res._meta["x402/payment-response"].result.transaction, "0xtest");
  } finally {
    await client.close();
  }
});

test("mcp rejects unknown tool, bad enum, and missing required args", async () => {
  await withClient(async (client) => {
    const unknown = await client.callTool({ name: "nope", arguments: {} }, undefined, { throwOnInvalidResult: false });
    assert.ok(unknown.isError || unknown.content?.[0]?.text, "unknown tool must not succeed");

    const badType = await client.callTool({ name: "dns_lookup", arguments: { domain: "example.com", type: "BOGUS" } });
    assert.equal(badType.isError, true);

    const missing = await client.callTool({ name: "dns_lookup", arguments: { type: "MX" } });
    assert.equal(missing.isError, true);

    const extra = await client.callTool({
      name: "repair_json", arguments: { input: "{a:1}", unexpected: true },
    });
    assert.equal(extra.isError, true, "unknown MCP arguments must be rejected, not stripped");
  });
});
