import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/entry.js";
import { PAY_TO, TOOLS } from "../src/shared.js";

test("worker entrypoint serves Open 402 manifest without payment", async () => {
  const response = await worker.fetch(
    new Request("https://penniless-json-repair.sjaman.workers.dev/.well-known/agent.json"),
    {},
    { waitUntil() {} },
  );

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /application\/json/);
  assert.match(response.headers.get("cache-control") ?? "", /max-age=300/);
  const manifest = await response.json();
  assert.equal(manifest.version, "1.4");
  assert.equal(manifest.origin, "penniless-json-repair.sjaman.workers.dev");
  assert.equal(manifest.payout_address, PAY_TO);
  assert.equal(manifest.intents.length, 10);
  assert.equal(manifest.intents[0].price.amount, Number(Object.values(TOOLS)[0].priceUsd));
  assert.equal(manifest.intents[0].price.network, "base");
});

test("worker entrypoint delegates existing free routes and keeps native MPP disabled", async () => {
  const env = { MPP_SECRET_KEY: "x".repeat(64) };
  const ctx = { waitUntil() {} };

  const health = await worker.fetch(
    new Request("https://penniless-json-repair.sjaman.workers.dev/health"),
    env,
    ctx,
  );
  assert.equal(health.status, 200);
  const healthBody = await health.json();
  assert.equal(healthBody.ok, true);
  assert.equal(healthBody.mppRestEnabled, false);

  const discovery = await worker.fetch(
    new Request("https://penniless-json-repair.sjaman.workers.dev/.well-known/x402"),
    env,
    ctx,
  );
  const discoveryBody = await discovery.json();
  assert.deepEqual(discoveryBody.mpp, { enabled: false });

  const openapi = await worker.fetch(
    new Request("https://penniless-json-repair.sjaman.workers.dev/openapi.json"),
    env,
    ctx,
  );
  const openapiBody = await openapi.json();
  assert.equal(openapiBody.info["x-payment-server"].mpp.enabled, false);
  assert.deepEqual(openapiBody.paths["/repair/json"].post["x-payment-info"].protocols, [{ x402: {} }]);
});
