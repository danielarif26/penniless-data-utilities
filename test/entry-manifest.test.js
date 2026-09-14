import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/entry.js";
import { PAY_TO, PRICE_USD } from "../src/shared.js";

test("worker entrypoint serves Open 402 manifest without payment", async () => {
  const response = await worker.fetch(
    new Request("https://penniless-json-repair.sjaman.workers.dev/.well-known/agent.json"),
    {},
    { waitUntil() {} },
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
  assert.match(response.headers.get("content-type") ?? "", /application\/json/);
  assert.match(response.headers.get("cache-control") ?? "", /max-age=300/);
  const manifest = await response.json();
  assert.equal(manifest.version, "1.4");
  assert.equal(manifest.origin, "penniless-json-repair.sjaman.workers.dev");
  assert.equal(manifest.payout_address, PAY_TO);
  assert.equal(manifest.intents.length, 9);
  assert.equal(manifest.intents[0].price.amount, Number(PRICE_USD));
  assert.equal(manifest.intents[0].price.network, "base");
});

test("worker entrypoint delegates existing free routes", async () => {
  const response = await worker.fetch(
    new Request("https://penniless-json-repair.sjaman.workers.dev/health"),
    {},
    { waitUntil() {} },
  );
  assert.equal(response.status, 200);
  assert.equal((await response.json()).ok, true);
});
