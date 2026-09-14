import test from "node:test";
import assert from "node:assert/strict";
import { createPennilessClient } from "../index.js";
import {
  FAKE_PRIVATE_KEY,
  jsonResponse,
  paymentResponse,
} from "./fixtures.js";

test("default x402 signer creates a payment retry when optional dependencies are installed", async (t) => {
  try {
    await Promise.all([
      import("@x402/core"),
      import("@x402/evm"),
      import("@x402/fetch"),
      import("viem"),
    ]);
  } catch (error) {
    t.skip(`real-signing tier skipped: optional client dependencies are not installed (${error.code || error.message})`);
    return;
  }

  const requests = [];
  const client = createPennilessClient({
    baseUrl: "https://service.invalid",
    privateKey: FAKE_PRIVATE_KEY,
    fetch: async (_url, init) => {
      requests.push(init);
      return requests.length === 1
        ? paymentResponse()
        : jsonResponse({ ok: true });
    },
  });

  assert.deepEqual(await client.tools.repairJson("{}"), { ok: true });
  assert.equal(requests.length, 2);
  assert.ok(new Headers(requests[1].headers).get("X-PAYMENT"));
});
