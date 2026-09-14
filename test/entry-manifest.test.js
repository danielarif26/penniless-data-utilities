import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/entry.js";
import { PAY_TO } from "../src/shared.js";

test("worker entrypoint serves Open 402 manifest without payment", async () => {
  const response = await worker.fetch(
    new Request("https://penniless-json-repair.sjaman.workers.dev/.well-known/agent.json"),
    {},
    { waitUntil() {} },
  );

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /application\/json/);
  const manifest = await response.json();
  assert.equal(manifest.origin, "penniless-json-repair.sjaman.workers.dev");
  assert.equal(manifest.payout_address, PAY_TO);
  assert.equal(manifest.intents.length, 9);
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
