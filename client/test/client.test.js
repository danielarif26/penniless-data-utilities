import test from "node:test";
import assert from "node:assert/strict";
import { inspect } from "node:util";
import { createPennilessClient } from "../index.js";
import {
  FAKE_PRIVATE_KEY,
  decodePaymentHeader,
  jsonResponse,
  paymentRequired,
  paymentResponse,
} from "./fixtures.js";

const BASE_URL = "https://service.invalid";
const SIGNED_PAYMENT = {
  x402Version: 2,
  payload: { signature: "0xoffline-signature", authorization: "0xoffline-authorization" },
};

function recordingSigner() {
  const calls = [];
  return {
    calls,
    adapter: {
      async sign(requirement) {
        calls.push(requirement);
        return SIGNED_PAYMENT;
      },
    },
  };
}

test("REST handshake signs once and retries once with X-PAYMENT", async () => {
  const requests = [];
  const signer = recordingSigner();
  const fakeFetch = async (url, init) => {
    requests.push({ url: String(url), init });
    if (requests.length === 1) return paymentResponse();
    return jsonResponse({ ok: true, repaired: { foo: 1 } });
  };
  const client = createPennilessClient({
    baseUrl: BASE_URL,
    fetch: fakeFetch,
    signerAdapter: signer.adapter,
  });

  const result = await client.tools.repairJson("{foo: 1,}");

  assert.deepEqual(result, { ok: true, repaired: { foo: 1 } });
  assert.equal(signer.calls.length, 1);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, `${BASE_URL}/repair/json`);
  assert.equal(new Headers(requests[0].init.headers).get("X-PAYMENT"), null);
  const paymentHeader = new Headers(requests[1].init.headers).get("X-PAYMENT");
  assert.ok(paymentHeader, "the retry must use the X-PAYMENT header");
  assert.deepEqual(decodePaymentHeader(paymentHeader), SIGNED_PAYMENT);
  assert.equal(requests[0].init.body, requests[1].init.body);
});

test("REST handshake reads the standard PAYMENT-REQUIRED header when the body is empty", async () => {
  const signer = recordingSigner();
  let fetchCalls = 0;
  const requirement = paymentRequired();
  const client = createPennilessClient({
    baseUrl: BASE_URL,
    signerAdapter: signer.adapter,
    fetch: async () => {
      fetchCalls += 1;
      if (fetchCalls === 1) {
        return new Response("{}", {
          status: 402,
          headers: {
            "content-type": "application/json",
            "payment-required": Buffer.from(JSON.stringify(requirement)).toString("base64"),
          },
        });
      }
      return jsonResponse({ ok: true });
    },
  });

  assert.deepEqual(await client.tools.repairJson("{}"), { ok: true });
  assert.equal(fetchCalls, 2);
  assert.equal(signer.calls.length, 1);
});

test("MCP handshake retries tools/call through params._meta x402/payment", async () => {
  const requests = [];
  const signer = recordingSigner();
  const fakeFetch = async (url, init) => {
    const request = JSON.parse(init.body);
    requests.push({ url: String(url), request });
    if (requests.length === 1) {
      const requirement = paymentRequired();
      return jsonResponse({
        jsonrpc: "2.0",
        id: request.id,
        result: {
          isError: true,
          content: [{ type: "text", text: JSON.stringify(requirement) }],
          structuredContent: requirement,
        },
      });
    }
    return jsonResponse({
      jsonrpc: "2.0",
      id: request.id,
      result: { content: [{ type: "text", text: "done" }], structuredContent: { ok: true } },
    });
  };
  const client = createPennilessClient({
    baseUrl: BASE_URL,
    fetch: fakeFetch,
    signerAdapter: signer.adapter,
  });

  const result = await client.mcp.tool("repair_json", { input: "{foo: 1,}" });

  assert.equal(requests.length, 2);
  assert.equal(signer.calls.length, 1);
  assert.equal(requests[0].url, `${BASE_URL}/mcp`);
  assert.equal(requests[0].request.method, "tools/call");
  assert.equal(requests[0].request.params._meta?.["x402/payment"], undefined);
  assert.deepEqual(requests[1].request.params._meta["x402/payment"], SIGNED_PAYMENT);
  assert.deepEqual(result, { content: [{ type: "text", text: "done" }], structuredContent: { ok: true } });
});

test("a second consecutive REST 402 is not retried in a loop", async () => {
  let fetchCalls = 0;
  const signer = recordingSigner();
  const client = createPennilessClient({
    baseUrl: BASE_URL,
    fetch: async () => {
      fetchCalls += 1;
      return paymentResponse();
    },
    signerAdapter: signer.adapter,
  });

  await assert.rejects(() => client.tools.repairJson("{}"), /402|payment required/i);
  assert.equal(fetchCalls, 2, "one unpaid request and one paid retry are allowed");
  assert.equal(signer.calls.length, 1);
});

test("400 and 500 responses propagate without signing", async (t) => {
  for (const status of [400, 500]) {
    await t.test(String(status), async () => {
      const signer = recordingSigner();
      const client = createPennilessClient({
        baseUrl: BASE_URL,
        fetch: async () => jsonResponse({ ok: false, error: `status ${status}` }, { status }),
        signerAdapter: signer.adapter,
      });

      await assert.rejects(() => client.tools.repairJson("{}"), new RegExp(String(status)));
      assert.equal(signer.calls.length, 0);
    });
  }
});

test("requirements above the default USDC tolerance are refused", async () => {
  const signer = recordingSigner();
  const client = createPennilessClient({
    baseUrl: BASE_URL,
    fetch: async () => paymentResponse({ accepted: { amount: "20001" } }),
    signerAdapter: signer.adapter,
  });

  await assert.rejects(() => client.tools.repairJson("{}"), /tolerance|0\.02|20001/i);
  assert.equal(signer.calls.length, 0, "an over-tolerance requirement must not be signed");
});

test("free helpers never invoke the signer and rawFetch returns its Response untouched", async () => {
  const signer = recordingSigner();
  const responses = [];
  const seen = [];
  const fakeFetch = async (url, init = {}) => {
    seen.push({ url: String(url), init });
    const response = jsonResponse({ ok: true, path: new URL(url).pathname });
    responses.push(response);
    return response;
  };
  const client = createPennilessClient({
    baseUrl: BASE_URL,
    fetch: fakeFetch,
    signerAdapter: signer.adapter,
  });

  assert.deepEqual(await client.health(), { ok: true, path: "/health" });
  assert.deepEqual(await client.stats(), { ok: true, path: "/stats" });
  assert.deepEqual(await client.diagnose("{bad"), { ok: true, path: "/diagnose" });
  const raw = await client.rawFetch("/openapi.json");

  assert.equal(raw, responses[3]);
  assert.equal(seen[0].url, `${BASE_URL}/health`);
  assert.equal(seen[1].url, `${BASE_URL}/stats`);
  assert.equal(seen[2].url, `${BASE_URL}/diagnose`);
  assert.equal(seen[3].url, `${BASE_URL}/openapi.json`);
  assert.equal(signer.calls.length, 0);
});

test("the client exposes all ten REST tool helpers", () => {
  const client = createPennilessClient({
    baseUrl: BASE_URL,
    fetch: async () => jsonResponse({ ok: true }),
    signerAdapter: recordingSigner().adapter,
  });
  assert.deepEqual(Object.keys(client.tools).sort(), [
    "cronNextRun",
    "cryptoPrice",
    "dnsLookup",
    "domainWhois",
    "emailValidate",
    "githubRepoStats",
    "repairJson",
    "textDiff",
    "textExtract",
    "yamlToJson",
  ]);
});

test("a supplied private key is absent from logs, errors, JSON, and inspection", async () => {
  const captured = [];
  const original = { log: console.log, warn: console.warn, error: console.error };
  console.log = (...args) => captured.push(args.map(String).join(" "));
  console.warn = (...args) => captured.push(args.map(String).join(" "));
  console.error = (...args) => captured.push(args.map(String).join(" "));

  let error;
  let client;
  try {
    client = createPennilessClient({
      baseUrl: BASE_URL,
      privateKey: FAKE_PRIVATE_KEY,
      fetch: async () => jsonResponse({ error: "offline failure" }, { status: 500 }),
      signerAdapter: recordingSigner().adapter,
    });
    await client.tools.repairJson("{}").catch((caught) => {
      error = caught;
    });
  } finally {
    console.log = original.log;
    console.warn = original.warn;
    console.error = original.error;
  }

  assert.ok(error instanceof Error);
  const observable = [
    captured.join("\n"),
    error.message,
    JSON.stringify(client),
    inspect(client),
  ].join("\n");
  assert.equal(observable.includes(FAKE_PRIVATE_KEY), false);
});
