// x402 v1 compatibility.
//
// This service speaks x402 v2: it advertises requirements in the
// PAYMENT-REQUIRED response header and reads payments from PAYMENT-SIGNATURE.
// A v1 client does neither — it reads requirements from the 402 JSON body and
// pays with X-PAYMENT — and @x402/core v2 leaves that body as `{}` and never
// looks at that header. A v1 payer therefore cannot discover the price, and
// cannot pay even if it already knows it. This module closes both halves.
//
// The signature itself is portable. A v1 `base` payer signs an EIP-3009
// authorization over chainId 8453 with the USDC contract as the EIP-712
// verifying contract, which is byte-for-byte what a v2 `eip155:8453` payer
// signs. Only the envelope around it differs, so translating the envelope is
// sufficient and nothing has to be re-signed.
//
// Nothing here decides whether a payment is good. The translated payload is
// matched against this server's own requirement, and the facilitator then
// verifies and settles against that same requirement — never against anything
// the client supplied. A payer that signs for less than the asking price still
// fails verification exactly as it would on the v2 rail.

// Requests carrying this header skip counter telemetry. It is stripped from
// every inbound request before routing, so only this module can set it.
export const INTERNAL_PROBE_HEADER = "x-pdu-internal-probe";

const V1_PAYMENT_HEADER = "x-payment";
// Native MPP carries its payment credential as `Authorization: Payment <...>`.
const MPP_CREDENTIAL_HEADER = "authorization";
const MPP_CREDENTIAL_SCHEME = /^payment\s/i;
const V1_SETTLEMENT_HEADER = "x-payment-response";
const V2_PAYMENT_HEADER = "payment-signature";
const V2_REQUIRED_HEADER = "payment-required";
const V2_SETTLEMENT_HEADER = "payment-response";

// v1 named its networks; v2 uses CAIP-2. Only the chains this service prices
// in are listed — an unknown network is passed through untranslated so it
// fails to match rather than silently resolving to the wrong chain.
const V1_NETWORK_BY_CAIP = { "eip155:8453": "base", "eip155:84532": "base-sepolia" };
const CAIP_BY_V1_NETWORK = Object.fromEntries(
  Object.entries(V1_NETWORK_BY_CAIP).map(([caip, v1]) => [v1, caip]),
);

function decodeBase64Json(value) {
  const binary = atob(value);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

function encodeBase64Json(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function hasMppCredential(request) {
  return MPP_CREDENTIAL_SCHEME.test(request.headers.get(MPP_CREDENTIAL_HEADER) ?? "");
}

export function hasPaymentHeader(request) {
  return request.headers.has(V2_PAYMENT_HEADER)
    || request.headers.has(V1_PAYMENT_HEADER)
    || hasMppCredential(request);
}

// A v1 payer is one that sent X-PAYMENT and nothing a v2 server would read.
// A client sending both is treated as v2 and left alone.
export function isV1Payment(request) {
  return request.headers.has(V1_PAYMENT_HEADER) && !request.headers.has(V2_PAYMENT_HEADER);
}

// Rebuilds the request only when something actually has to change, so the
// common path keeps the original object and never buffers a body.
export async function normalizeRequest(request, paidPath = true) {
  const spoofed = request.headers.has(INTERNAL_PROBE_HEADER);
  const v1 = paidPath && isV1Payment(request);
  if (!spoofed && !v1) return { request, body: null, isV1: false };

  const body = request.method === "GET" || request.method === "HEAD"
    ? null
    : await request.arrayBuffer();
  const headers = new Headers(request.headers);
  headers.delete(INTERNAL_PROBE_HEADER);
  return {
    request: new Request(request.url, { method: request.method, headers, body }),
    body,
    isV1: v1,
  };
}

// Asks the paywall what it currently requires, without spending the real
// request. Routes are registered for every method, so a bodiless request to
// the same URL returns the same requirement the real call would be judged by.
//
// The probe must carry no payment credential of any rail. It only needs the
// 402 challenge, and its response is discarded — an MPP credential left on it
// would be verified and settled on-chain against a result nobody receives,
// charging the caller for nothing.
export function probeRequest(request) {
  const headers = new Headers(request.headers);
  headers.delete(V1_PAYMENT_HEADER);
  headers.delete(V2_PAYMENT_HEADER);
  if (hasMppCredential(request)) headers.delete(MPP_CREDENTIAL_HEADER);
  headers.set(INTERNAL_PROBE_HEADER, "1");
  return new Request(request.url, { method: request.method, headers });
}

export function readPaymentRequired(response) {
  const header = response.headers.get(V2_REQUIRED_HEADER);
  if (!header) return null;
  try {
    return decodeBase64Json(header);
  } catch {
    return null;
  }
}

// Picks the advertised requirement the v1 payload is actually paying against,
// rather than reconstructing one. Whatever the server advertises is what the
// facilitator will verify, so the two can never drift apart.
export function matchRequirement(paymentRequired, v1Payload) {
  const wanted = CAIP_BY_V1_NETWORK[v1Payload?.network] ?? v1Payload?.network;
  return (paymentRequired?.accepts ?? []).find(
    (accepted) => accepted.scheme === v1Payload?.scheme && accepted.network === wanted,
  ) ?? null;
}

export function readV1Payment(request) {
  const header = request.headers.get(V1_PAYMENT_HEADER);
  if (!header) return null;
  let payload;
  try {
    payload = decodeBase64Json(header);
  } catch {
    return null;
  }
  if (payload?.x402Version !== 1 || !payload.scheme || !payload.network || !payload.payload) return null;
  return payload;
}

// Re-envelopes a v1 payment as the v2 payload the middleware understands. The
// signed authorization is carried across untouched.
export function upgradeToV2(request, body, v1Payload, requirement) {
  const headers = new Headers(request.headers);
  headers.delete(V1_PAYMENT_HEADER);
  headers.set(V2_PAYMENT_HEADER, encodeBase64Json({
    x402Version: 2,
    accepted: requirement,
    payload: v1Payload.payload,
  }));
  return new Request(request.url, { method: request.method, headers, body });
}

function v1Requirement(accepted, resource) {
  return {
    scheme: accepted.scheme,
    network: V1_NETWORK_BY_CAIP[accepted.network] ?? accepted.network,
    maxAmountRequired: accepted.amount,
    resource: resource?.url ?? "",
    description: resource?.description ?? "",
    mimeType: resource?.mimeType || "application/json",
    payTo: accepted.payTo,
    maxTimeoutSeconds: accepted.maxTimeoutSeconds,
    asset: accepted.asset,
    ...(accepted.extra !== undefined ? { extra: accepted.extra } : {}),
  };
}

// Fills the empty 402 body with the v1 form of the same offer. The v2 header
// is left in place, so a v2 client is unaffected and a v1 client now has
// something to read. The browser paywall (HTML) is never rewritten.
export async function addV1PaymentRequiredBody(response) {
  if (response.status !== 402) return response;
  if (!(response.headers.get("content-type") ?? "").includes("application/json")) return response;
  const paymentRequired = readPaymentRequired(response);
  if (!paymentRequired?.accepts?.length) return response;

  let existing;
  try {
    existing = await response.clone().json();
  } catch {
    return response;
  }
  // Only an empty placeholder body is replaced; a real error stays intact.
  if (existing && Object.keys(existing).length > 0) return response;

  // The placeholder body is being replaced with a longer one, so any length
  // the runtime had already fixed on the response no longer describes it.
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  return new Response(JSON.stringify({
    x402Version: 1,
    error: paymentRequired.error || "X-PAYMENT header is required",
    accepts: paymentRequired.accepts.map((accepted) => v1Requirement(accepted, paymentRequired.resource)),
  }), { status: 402, headers });
}

// v1 clients read the receipt from X-PAYMENT-RESPONSE. The v2 header stays so
// the response remains valid on both rails.
export function mirrorV1Settlement(response) {
  const settlement = response.headers.get(V2_SETTLEMENT_HEADER);
  if (!settlement || response.headers.has(V1_SETTLEMENT_HEADER)) return response;
  const headers = new Headers(response.headers);
  headers.set(V1_SETTLEMENT_HEADER, settlement);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
