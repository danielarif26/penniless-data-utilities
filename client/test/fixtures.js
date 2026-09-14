export const ASSET = "0x1111111111111111111111111111111111111111";
export const PAY_TO = "0x2222222222222222222222222222222222222222";
export const FAKE_PRIVATE_KEY =
  "0x0123456789012345678901234567890123456789012345678901234567890123";

export function paymentRequired(overrides = {}) {
  const accepted = {
    scheme: "exact",
    network: "eip155:8453",
    amount: "1000",
    asset: ASSET,
    payTo: PAY_TO,
    maxTimeoutSeconds: 300,
    extra: { name: "USD Coin", version: "2" },
    ...overrides.accepted,
  };

  return {
    x402Version: 2,
    error: "Payment Required",
    accepts: [accepted],
    resource: {
      url: "https://service.invalid/repair/json",
      description: "Offline test resource",
      mimeType: "application/json",
    },
    ...overrides.root,
  };
}

export function jsonResponse(value, init = {}) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

export function paymentResponse(overrides) {
  return jsonResponse(paymentRequired(overrides), { status: 402 });
}

export function decodePaymentHeader(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return JSON.parse(Buffer.from(value, "base64").toString("utf8"));
  }
}
