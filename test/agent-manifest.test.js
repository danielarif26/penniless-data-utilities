import test from "node:test";
import assert from "node:assert/strict";
import { buildAgentManifest } from "../src/agent-manifest.js";
import { PAY_TO, PRICE_USD, TOOLS, USDC_BASE } from "../src/shared.js";

test("agent.json manifest exposes every paid tool with Base USDC pricing", () => {
  const manifest = buildAgentManifest();

  assert.equal(manifest.version, "1.4");
  assert.equal(manifest.origin, "penniless-json-repair.sjaman.workers.dev");
  assert.equal(manifest.payout_address, PAY_TO);
  assert.deepEqual(manifest.payments.x402.networks, [{
    network: "base",
    asset: "USDC",
    contract: USDC_BASE,
  }]);

  assert.equal(manifest.intents.length, Object.keys(TOOLS).length);
  const byEndpoint = new Map(manifest.intents.map((intent) => [intent.endpoint, intent]));
  for (const [endpoint, tool] of Object.entries(TOOLS)) {
    const intent = byEndpoint.get(endpoint);
    assert.ok(intent, `missing intent for ${endpoint}`);
    assert.equal(intent.name, tool.mcpName);
    assert.equal(intent.method, "POST");
    assert.equal(intent.price.amount, Number(PRICE_USD));
    assert.equal(intent.price.currency, "USDC");
    for (const required of tool.schema.required ?? []) {
      assert.equal(intent.parameters[required]?.required, true, `${endpoint} ${required} should be required`);
    }
  }
});
