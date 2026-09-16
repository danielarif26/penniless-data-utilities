import test from "node:test";
import assert from "node:assert/strict";
import { x402Client } from "@x402/core/client";
import { x402HTTPClient } from "@x402/core/http";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";
import app from "../src/index.js";
import { NETWORK, PAY_TO, TOOLS } from "../src/shared.js";

// The app owns its resource server, so keep its real x402 middleware while
// replacing just the lazy facilitator client. This mirrors mcp.test.js:
// requirement construction is real and the suite never reaches the network.
const realGetSupported = HTTPFacilitatorClient.prototype.getSupported;
const realVerify = HTTPFacilitatorClient.prototype.verify;
const realSettle = HTTPFacilitatorClient.prototype.settle;
let verifyCalls = 0;
let settleCalls = 0;
HTTPFacilitatorClient.prototype.getSupported = async () => ({
  kinds: [{ x402Version: 2, scheme: "exact", network: NETWORK }],
  extensions: [],
  signers: {},
});
HTTPFacilitatorClient.prototype.verify = async () => {
  verifyCalls += 1;
  return { isValid: true };
};
HTTPFacilitatorClient.prototype.settle = async () => {
  settleCalls += 1;
  return { success: true, transaction: "0xtest", network: NETWORK };
};

test.after(() => {
  HTTPFacilitatorClient.prototype.getSupported = realGetSupported;
  HTTPFacilitatorClient.prototype.verify = realVerify;
  HTTPFacilitatorClient.prototype.settle = realSettle;
});

const PAID_METHODS = ["GET", "HEAD", "OPTIONS", "PUT", "DELETE", "POST"];
const payer = privateKeyToAccount(
  "0x0123456789012345678901234567890123456789012345678901234567890123",
);
const paymentClient = new x402HTTPClient(
  new x402Client().register(NETWORK, new ExactEvmScheme(payer)),
);

function request(path, method, headers = {}, body = { input: "{foo: 1,}" }) {
  const init = { method, headers };
  if (method === "POST") {
    init.headers = { "content-type": "application/json", ...headers };
    init.body = JSON.stringify(body);
  }
  return new Request(`http://localhost${path}`, init);
}

function paymentRequired(response, label) {
  const encoded = response.headers.get("payment-required");
  assert.ok(encoded, `${label} must include PAYMENT-REQUIRED`);
  let requirement;
  try {
    requirement = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
  } catch (error) {
    assert.fail(`${label} has an undecodable PAYMENT-REQUIRED header: ${error.message}`);
  }
  return requirement;
}

function assertRequirement(requirement, label, tool) {
  assert.equal(requirement.x402Version, 2, `${label} x402 version`);
  assert.equal(requirement.accepts?.[0]?.scheme, "exact", `${label} scheme`);
  assert.equal(requirement.accepts?.[0]?.network, "eip155:8453", `${label} network`);
  assert.equal(requirement.accepts?.[0]?.amount, tool.priceAtomic, `${label} amount`);
  assert.equal(requirement.accepts?.[0]?.payTo, PAY_TO, `${label} payTo`);
}

function assertBazaarDiscovery(requirement, label) {
  assert.equal(requirement.extensions?.bazaar?.info?.input?.type, "http", `${label} bazaar input type`);
  assert.equal(requirement.extensions?.bazaar?.info?.input?.method, "POST", `${label} bazaar method`);
  assert.equal(requirement.extensions?.bazaar?.info?.input?.bodyType, "json", `${label} bazaar body type`);
  assert.ok(requirement.extensions?.bazaar?.schema, `${label} bazaar schema`);
}

test("every paid REST path requires the same x402 v2 payment for every HTTP method", async (t) => {
  for (const path of Object.keys(TOOLS)) {
    for (const method of PAID_METHODS) {
      await t.test(`${method} ${path}`, async () => {
        const response = await app.fetch(request(path, method));
        const label = `${method} ${path}`;
        assert.equal(response.status, 402, `${label} must be paywalled`);
        const requirement = paymentRequired(response, label);
        assertRequirement(requirement, label, TOOLS[path]);
        if (method === "POST") {
          assertBazaarDiscovery(requirement, label);
        } else {
          assert.equal(requirement.extensions?.bazaar, undefined, `${label} must not advertise a non-callable method`);
        }
      });
    }
  }
});

test("a payment echoed from the real requirement cannot settle a non-successful GET", async () => {
  const unpaid = await app.fetch(request("/repair/json", "GET"));
  assert.equal(unpaid.status, 402);
  const requirement = paymentRequired(unpaid, "GET /repair/json");
  const payment = await paymentClient.createPaymentPayload(requirement);
  const verificationsBefore = verifyCalls;
  const before = settleCalls;
  const response = await app.fetch(request("/repair/json", "GET", {
    ...paymentClient.encodePaymentSignatureHeader(payment),
  }));

  assert.equal(response.status, 404, "paid GET must be rejected as an unsupported method");
  assert.equal(verifyCalls, verificationsBefore + 1, "the echoed payment must be verified");
  assert.equal(settleCalls, before, "a non-2xx GET must not settle or charge payment");
});

test("a paid POST whose tool returns ok:false is not settled or charged", async () => {
  const unpaid = await app.fetch(request("/repair/json", "POST"));
  assert.equal(unpaid.status, 402);
  const requirement = paymentRequired(unpaid, "POST /repair/json");
  const payment = await paymentClient.createPaymentPayload(requirement);
  const verificationsBefore = verifyCalls;
  const settlementsBefore = settleCalls;
  const response = await app.fetch(request("/repair/json", "POST", {
    ...paymentClient.encodePaymentSignatureHeader(payment),
  }, { input: "not remotely json" }));

  assert.equal(response.status, 422, "tool-level failure must be non-2xx");
  assert.equal((await response.json()).ok, false);
  assert.equal(verifyCalls, verificationsBefore + 1, "payment may be verified before tool execution");
  assert.equal(settleCalls, settlementsBefore, "failed tool output must not settle or charge payment");
  assert.equal(response.headers.get("payment-response"), null, "failed tool output must not carry a settlement receipt");
});

test("a paid POST still runs its handler and settles exactly once", async () => {
  const unpaid = await app.fetch(request("/repair/json", "POST"));
  assert.equal(unpaid.status, 402);
  const requirement = paymentRequired(unpaid, "POST /repair/json");
  const payment = await paymentClient.createPaymentPayload(requirement);
  const verificationsBefore = verifyCalls;
  const settlementsBefore = settleCalls;
  const response = await app.fetch(request("/repair/json", "POST", {
    ...paymentClient.encodePaymentSignatureHeader(payment),
  }));

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    repaired: { foo: 1 },
    applied: ["unquoted-keys", "trailing-commas"],
  });
  assert.equal(verifyCalls, verificationsBefore + 1);
  assert.equal(settleCalls, settlementsBefore + 1, "a successful paid POST must settle once");
  assert.ok(response.headers.get("payment-response"), "settlement response header must be returned");
});

test("free REST discovery and diagnostic endpoints stay free", async () => {
  const freeRequests = [
    ["GET", "/health"],
    ["GET", "/"],
    ["GET", "/stats"],
    ["POST", "/diagnose"],
    ["GET", "/.well-known/x402"],
    ["GET", "/openapi.json"],
    ["GET", "/llms.txt"],
  ];

  for (const [method, path] of freeRequests) {
    const response = await app.fetch(request(path, method));
    assert.equal(response.status, 200, `${method} ${path} must be free`);
  }
});

test("root and machine-readable discovery derive all ten route prices from the catalogue", async () => {
  const [root, discovery, openapi] = await Promise.all([
    app.fetch(request("/", "GET")),
    app.fetch(request("/.well-known/x402", "GET")),
    app.fetch(request("/openapi.json", "GET")),
  ]);
  const rootBody = await root.json();
  const discoveryBody = await discovery.json();
  const openapiBody = await openapi.json();

  assert.equal(rootBody.tools.length, 10);
  assert.equal(discoveryBody.resources.filter((resource) => resource.accepts.length > 0).length, 10);
  for (const [path, tool] of Object.entries(TOOLS)) {
    assert.equal(rootBody.tools.find((item) => item.path === path)?.price, tool.price, `${path} root price`);
    assert.equal(
      discoveryBody.resources.find((item) => new URL(item.url).pathname === path)?.accepts?.[0]?.price,
      tool.price,
      `${path} discovery price`,
    );
    assert.equal(openapiBody.paths[path].post["x-payment-info"].price.amount, tool.priceUsd, `${path} OpenAPI price`);
  }
});
