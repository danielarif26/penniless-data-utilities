import test from "node:test";
import assert from "node:assert/strict";
import { parsePaymentRequirement } from "../index.js";
import { ASSET, PAY_TO, paymentRequired } from "./fixtures.js";

test("parsePaymentRequirement accepts and normalizes an x402 v2 accepts array", () => {
  const parsed = parsePaymentRequirement(paymentRequired());

  assert.equal(parsed.x402Version, 2);
  assert.equal(parsed.scheme, "exact");
  assert.equal(parsed.network, "eip155:8453");
  assert.equal(parsed.maxAmountNormalized, "1000");
  assert.equal(parsed.asset, ASSET);
  assert.equal(parsed.payTo, PAY_TO);
  assert.equal(parsed.resource, "https://service.invalid/repair/json");
  assert.equal(parsed.mimeType, "application/json");
  assert.equal(parsed.maxTimeoutSeconds, 300);
});

test("parsePaymentRequirement accepts a legacy-ish flat requirement and Base alias", () => {
  const parsed = parsePaymentRequirement({
    x402Version: 2,
    scheme: "exact",
    network: "base",
    maxAmountRequired: "1000",
    asset: ASSET,
    payTo: PAY_TO,
    resource: "https://service.invalid/diff",
    mimeType: "application/json",
    maxTimeoutSeconds: 60,
  });

  assert.equal(parsed.network, "eip155:8453");
  assert.equal(parsed.maxAmountNormalized, "1000");
  assert.equal(parsed.resource, "https://service.invalid/diff");
});

test("parsePaymentRequirement accepts paymentRequirements and errorBody wrappers", () => {
  const requirement = {
    scheme: "exact",
    network: "eip155:8453",
    maxAmountRequired: "1000",
    asset: ASSET,
    payTo: PAY_TO,
    resource: "https://service.invalid/diff",
    mimeType: "application/json",
    maxTimeoutSeconds: 60,
  };

  assert.equal(parsePaymentRequirement({ x402Version: 2, paymentRequirements: requirement }).amount, "1000");
  assert.equal(parsePaymentRequirement({ errorBody: { x402Version: 2, ...requirement } }).amount, "1000");
});

test("parsePaymentRequirement rejects a non-v2 payload", () => {
  assert.throws(
    () => parsePaymentRequirement(paymentRequired({ root: { x402Version: 1 } })),
    /x402Version.*2/i,
  );
});

test("parsePaymentRequirement rejects a non-exact network", () => {
  assert.throws(
    () => parsePaymentRequirement(paymentRequired({ accepted: { network: "eip155:1" } })),
    /network.*eip155:8453/i,
  );
});

test("parsePaymentRequirement rejects a missing payTo address", () => {
  const payload = paymentRequired();
  delete payload.accepts[0].payTo;
  assert.throws(() => parsePaymentRequirement(payload), /payTo.*required|payTo.*address/i);
});

test("parsePaymentRequirement rejects a non-positive amount", () => {
  for (const amount of ["0", "-1", "1.5", 1000]) {
    assert.throws(
      () => parsePaymentRequirement(paymentRequired({ accepted: { amount } })),
      /amount.*positive decimal string|amount.*positive integer string/i,
      `amount ${JSON.stringify(amount)} must be rejected`,
    );
  }
});
