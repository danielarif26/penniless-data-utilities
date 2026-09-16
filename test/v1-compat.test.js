import test from "node:test";
import assert from "node:assert/strict";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactEvmSchemeV1 } from "@x402/evm/v1";
import { privateKeyToAccount } from "viem/accounts";
import worker from "../src/entry.js";
import { hasPaymentHeader, probeRequest } from "../src/v1compat.js";
import { NETWORK, PAY_TO, PRICE_ATOMIC, TOOLS, USDC_BASE } from "../src/shared.js";

// The facilitator is replaced, but every requirement and every signature below
// is real: the v1 client signs an actual EIP-712 authorization, and the stub
// applies the same checks a facilitator applies before settling.
const realGetSupported = HTTPFacilitatorClient.prototype.getSupported;
const realVerify = HTTPFacilitatorClient.prototype.verify;
const realSettle = HTTPFacilitatorClient.prototype.settle;

let lastVerify = null;
HTTPFacilitatorClient.prototype.getSupported = async () => ({
  kinds: [{ x402Version: 2, scheme: "exact", network: NETWORK }],
  extensions: [],
  signers: {},
});
// Stands in for the facilitator's economic check: the signed authorization has
// to pay at least the asking amount, to the address the server named.
HTTPFacilitatorClient.prototype.verify = async (payload, requirements) => {
  lastVerify = { payload, requirements };
  const authorization = payload?.payload?.authorization;
  const paysEnough = BigInt(authorization?.value ?? 0) >= BigInt(requirements.amount);
  const paysUs = String(authorization?.to).toLowerCase() === String(requirements.payTo).toLowerCase();
  return paysEnough && paysUs
    ? { isValid: true }
    : { isValid: false, invalidReason: "insufficient_value" };
};
HTTPFacilitatorClient.prototype.settle = async () => ({ success: true, transaction: "0xv1", network: NETWORK });

test.after(() => {
  HTTPFacilitatorClient.prototype.getSupported = realGetSupported;
  HTTPFacilitatorClient.prototype.verify = realVerify;
  HTTPFacilitatorClient.prototype.settle = realSettle;
});

const payer = privateKeyToAccount(
  "0x0123456789012345678901234567890123456789012345678901234567890123",
);
const v1Client = new ExactEvmSchemeV1(payer);

function post(headers = {}) {
  return new Request("http://localhost/repair/json", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ input: "{foo: 'bar',}" }),
  });
}

function encode(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64");
}

async function fetchWorker(request) {
  return worker.fetch(request, {}, { waitUntil() {} });
}

test("an unpaid 402 carries the v1 offer in its body and the v2 offer in its header", async () => {
  const response = await fetchWorker(post());
  assert.equal(response.status, 402);
  assert.ok(response.headers.get("payment-required"), "v2 header must survive");

  const body = await response.json();
  assert.equal(body.x402Version, 1);
  assert.equal(body.accepts.length, 1);
  const [offer] = body.accepts;
  assert.equal(offer.scheme, "exact");
  // v1 names its networks; the CAIP-2 id would be meaningless to a v1 signer.
  assert.equal(offer.network, "base");
  assert.equal(offer.maxAmountRequired, PRICE_ATOMIC);
  assert.equal(offer.payTo, PAY_TO);
  assert.equal(offer.asset, USDC_BASE);
  assert.equal(offer.extra?.name, "USD Coin");
  assert.ok(offer.resource.endsWith("/repair/json"));
  assert.ok(offer.maxTimeoutSeconds > 0);
});

test("a v1 client pays with X-PAYMENT and is served, settled, and receipted", async () => {
  const offer = (await (await fetchWorker(post())).json()).accepts[0];
  const payload = await v1Client.createPaymentPayload(1, offer);

  // Signed by the official v1 scheme against the offer we advertised.
  assert.equal(payload.x402Version, 1);
  assert.equal(payload.network, "base");
  assert.equal(payload.payload.authorization.value, PRICE_ATOMIC);

  const response = await fetchWorker(post({ "x-payment": encode(payload) }));
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).repaired, { foo: "bar" });

  // The receipt is mirrored onto the header a v1 client reads.
  assert.ok(response.headers.get("x-payment-response"), "v1 receipt header");
  assert.ok(response.headers.get("payment-response"), "v2 receipt header");

  // Verification ran against this server's own requirement, not the client's.
  assert.equal(lastVerify.requirements.amount, PRICE_ATOMIC);
  assert.equal(lastVerify.requirements.network, NETWORK);
  assert.equal(lastVerify.requirements.payTo, PAY_TO);
});

test("a v1 payer that signs for less than the asking price is refused", async () => {
  const offer = (await (await fetchWorker(post())).json()).accepts[0];
  const underpaid = await v1Client.createPaymentPayload(1, { ...offer, maxAmountRequired: "1" });
  assert.equal(underpaid.payload.authorization.value, "1");

  const response = await fetchWorker(post({ "x-payment": encode(underpaid) }));
  assert.equal(response.status, 402);
  // The shim asserts the server's own terms, so the short authorization is
  // what the facilitator sees and rejects.
  assert.equal(lastVerify.requirements.amount, PRICE_ATOMIC);
});

test("a v1 payer that redirects payment to another address is refused", async () => {
  const offer = (await (await fetchWorker(post())).json()).accepts[0];
  const elsewhere = "0x000000000000000000000000000000000000dEaD";
  const diverted = await v1Client.createPaymentPayload(1, { ...offer, payTo: elsewhere });

  const response = await fetchWorker(post({ "x-payment": encode(diverted) }));
  assert.equal(response.status, 402);
  assert.equal(lastVerify.requirements.payTo, PAY_TO);
});

test("a malformed X-PAYMENT is answered with the v1 offer instead of an error", async () => {
  const response = await fetchWorker(post({ "x-payment": "not-base64-json" }));
  assert.equal(response.status, 402);
  assert.equal((await response.json()).x402Version, 1);
});

test("a v2 payer is unaffected by the v1 rail", async () => {
  const unpaid = await fetchWorker(post());
  const required = JSON.parse(
    Buffer.from(unpaid.headers.get("payment-required"), "base64").toString("utf8"),
  );
  const accepted = required.accepts[0];
  const v1Payload = await v1Client.createPaymentPayload(1, (await unpaid.json()).accepts[0]);

  const response = await fetchWorker(post({
    "payment-signature": encode({ x402Version: 2, accepted, payload: v1Payload.payload }),
  }));
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).repaired, { foo: "bar" });
});

test("the internal probe header cannot be set by a caller", async () => {
  const seen = [];
  const db = {
    prepare(sql) {
      return { bind: (...args) => ({ run: async () => { seen.push({ sql, args }); } }), run: async () => {} };
    },
  };
  const pending = [];
  await worker.fetch(
    post({ "x-pdu-internal-probe": "1" }),
    { DB: db },
    { waitUntil: (promise) => pending.push(Promise.resolve(promise)) },
  );
  await Promise.allSettled(pending);
  // The header is stripped at the door, so the request is still counted.
  assert.ok(seen.some((entry) => entry.args?.includes("/repair/json")), "spoofed probe must still be counted");
});

test("every paid path answers a v1 client with a usable offer", async () => {
  for (const path of Object.keys(TOOLS)) {
    const response = await fetchWorker(new Request(`http://localhost${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }));
    assert.equal(response.status, 402, `${path} must be paywalled`);
    const body = await response.json();
    assert.equal(body.x402Version, 1, `${path} must carry a v1 offer`);
    assert.equal(body.accepts[0].maxAmountRequired, PRICE_ATOMIC, `${path} price`);
    assert.ok(body.accepts[0].resource.endsWith(path), `${path} resource url`);
  }
});

test("an X-PAYMENT aimed at a free path is not translated and does not re-run the handler", async () => {
  let calls = 0;
  const counted = new Request("http://localhost/diagnose", {
    method: "POST",
    headers: { "content-type": "application/json", "x-payment": "irrelevant" },
    body: JSON.stringify({ input: "{a:1,}" }),
  });
  const db = {
    prepare(sql) {
      return {
        bind: (...args) => ({ run: async () => { if (args.includes("/diagnose")) calls += 1; } }),
        run: async () => {},
      };
    },
  };
  const pending = [];
  const response = await worker.fetch(counted, { DB: db }, {
    waitUntil: (promise) => pending.push(Promise.resolve(promise)),
  });
  await Promise.allSettled(pending);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).parsesNow, false);
  // One execution, not a probe plus a replay.
  assert.equal(calls, 1);
});

// Forged payment envelopes, against a facilitator that rejects everything and
// records what it was asked to verify. The point is not just that these are
// refused: it is that the terms reaching the facilitator are always this
// server's own, never the ones the attacker put in the envelope.
test("a forged envelope can neither be served nor tamper with the terms verified", async () => {
  const attacker = "0x000000000000000000000000000000000000dEaD";
  const forgedAuthorization = {
    signature: `0x${"11".repeat(65)}`,
    authorization: {
      from: attacker, to: attacker, value: "1",
      validAfter: "0", validBefore: "99999999999", nonce: `0x${"22".repeat(32)}`,
    },
  };
  const cheapTerms = {
    scheme: "exact", network: NETWORK, amount: "1",
    asset: USDC_BASE, payTo: attacker, maxTimeoutSeconds: 300,
  };
  const v1 = (extra = {}) => ({
    x402Version: 1, scheme: "exact", network: "base", payload: forgedAuthorization, ...extra,
  });

  const variants = {
    "v1 underpaying and redirecting payTo": { "x-payment": encode(v1()) },
    "v1 declaring a CAIP-2 network": { "x-payment": encode(v1({ network: NETWORK })) },
    "v1 smuggling its own accepted terms": { "x-payment": encode(v1({ accepted: cheapTerms })) },
    "v2 with forged accepted terms": {
      "payment-signature": encode({ x402Version: 2, accepted: cheapTerms, payload: forgedAuthorization }),
    },
    "v1 payload inside a v2 envelope": {
      "payment-signature": encode({ x402Version: 1, accepted: cheapTerms, payload: forgedAuthorization }),
    },
    "both payment headers at once": {
      "x-payment": encode(v1()),
      "payment-signature": encode({ x402Version: 2, accepted: cheapTerms, payload: forgedAuthorization }),
    },
    "a spoofed internal probe header": { "x-pdu-internal-probe": "1" },
    "a spoofed probe carrying a forged v1 payment": {
      "x-pdu-internal-probe": "1", "x-payment": encode(v1()),
    },
    "a forged payment dressed as a browser": {
      "x-payment": encode(v1()), "user-agent": "Mozilla/5.0", accept: "text/html",
    },
  };

  const permissiveVerify = HTTPFacilitatorClient.prototype.verify;
  const permissiveSettle = HTTPFacilitatorClient.prototype.settle;
  const seen = [];
  HTTPFacilitatorClient.prototype.verify = async (payload, requirements) => {
    seen.push(requirements);
    return { isValid: false, invalidReason: "invalid_signature" };
  };
  HTTPFacilitatorClient.prototype.settle = async () => {
    assert.fail("a forged payment must never reach settlement");
  };
  try {
    for (const [name, headers] of Object.entries(variants)) {
      seen.length = 0;
      const response = await fetchWorker(post(headers));
      assert.notEqual(response.status, 200, `${name} must not be served`);
      for (const requirements of seen) {
        assert.equal(requirements.payTo, PAY_TO, `${name}: payTo was tampered with`);
        assert.equal(requirements.amount, PRICE_ATOMIC, `${name}: amount was tampered with`);
        assert.equal(requirements.network, NETWORK, `${name}: network was tampered with`);
      }
    }
  } finally {
    HTTPFacilitatorClient.prototype.verify = permissiveVerify;
    HTTPFacilitatorClient.prototype.settle = permissiveSettle;
  }
});

// The probe's response is thrown away. Any payment credential left on it would
// be verified and settled against a result nobody receives -- on the MPP rail
// that is a real on-chain transfer, and the caller is then told to send only
// one credential, having already paid.
test("the probe carries no payment credential of any rail", () => {
  const probe = probeRequest(new Request("http://localhost/repair/json", {
    method: "POST",
    headers: {
      "x-payment": "v1-credential",
      "payment-signature": "v2-credential",
      authorization: "Payment mpp-credential",
      "content-type": "application/json",
    },
  }));
  assert.equal(probe.headers.get("x-payment"), null);
  assert.equal(probe.headers.get("payment-signature"), null);
  assert.equal(probe.headers.get("authorization"), null);
  assert.equal(probe.headers.get("x-pdu-internal-probe"), "1");
  // Everything unrelated to payment still describes the same request.
  assert.equal(probe.headers.get("content-type"), "application/json");
  assert.equal(probe.method, "POST");
});

test("a non-payment Authorization header is left alone", () => {
  const probe = probeRequest(new Request("http://localhost/repair/json", {
    method: "POST",
    headers: { authorization: "Bearer not-a-payment", "x-payment": "v1" },
  }));
  assert.equal(probe.headers.get("authorization"), "Bearer not-a-payment");
});

test("an MPP credential counts as an attempt to pay", () => {
  const mpp = new Request("http://localhost/repair/json", {
    method: "POST",
    headers: { authorization: "Payment mpp-credential" },
  });
  assert.equal(hasPaymentHeader(mpp), true);
  const bearer = new Request("http://localhost/repair/json", {
    method: "POST",
    headers: { authorization: "Bearer session-token" },
  });
  assert.equal(hasPaymentHeader(bearer), false);
});
