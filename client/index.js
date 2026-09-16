const DEFAULT_BASE_URL = "https://penniless-json-repair.sjaman.workers.dev";
const DEFAULT_TOLERANCE_USDC = 0.02;
const BASE_NETWORK = "eip155:8453";
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const DECIMAL_INTEGER = /^[0-9]+$/;
const INSPECT_CUSTOM = Symbol.for("nodejs.util.inspect.custom");

const TOOL_PATHS = Object.freeze({
  repairJson: "/repair/json",
  yamlToJson: "/yaml/tojson",
  cronNextRun: "/cron/nextrun",
  textDiff: "/diff",
  textExtract: "/text/extract",
  domainWhois: "/domain/whois",
  dnsLookup: "/dns/lookup",
  githubRepoStats: "/github/repo-stats",
  cryptoPrice: "/price/crypto",
  emailValidate: "/email/validate",
});

function fail(field, expectation) {
  throw new Error(`Invalid x402 payment requirement: ${field} ${expectation}`);
}

function asObject(value, label = "payload") {
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      fail(label, "must be valid JSON");
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(label, "must be an object");
  }
  return value;
}

function paymentCandidates(payload) {
  const candidates = [];
  const seen = new Set();
  const visit = (value, inheritedVersion, inheritedResource, depth = 0) => {
    if (depth > 6 || value == null) return;
    if (typeof value === "string") {
      try { visit(JSON.parse(value), inheritedVersion, inheritedResource, depth + 1); } catch { /* not JSON */ }
      return;
    }
    if (typeof value !== "object" || seen.has(value)) return;
    seen.add(value);

    const version = value.x402Version ?? inheritedVersion;
    const resource = value.resource ?? inheritedResource;
    if (Array.isArray(value.accepts)) {
      for (const entry of value.accepts) candidates.push({ entry, version, resource, root: value });
    }
    for (const key of ["paymentRequirements", "errorBody"]) {
      const nested = value[key];
      if (Array.isArray(nested)) {
        for (const entry of nested) candidates.push({ entry, version, resource, root: value });
      } else if (nested && typeof nested === "object") {
        if (Array.isArray(nested.accepts)) visit(nested, version, resource, depth + 1);
        else candidates.push({ entry: nested, version: nested.x402Version ?? version, resource: nested.resource ?? resource, root: value });
      } else if (typeof nested === "string") {
        visit(nested, version, resource, depth + 1);
      }
    }

    if (value.scheme !== undefined || value.network !== undefined || value.amount !== undefined || value.maxAmountRequired !== undefined) {
      candidates.push({ entry: value, version, resource, root: value });
    }
    for (const key of ["result", "structuredContent", "data", "error"]) {
      visit(value[key], version, resource, depth + 1);
    }
    if (Array.isArray(value.content)) {
      for (const item of value.content) visit(item?.text ?? item, version, resource, depth + 1);
    }
  };
  visit(payload);
  return candidates;
}

function validateCandidate(candidate) {
  const entry = asObject(candidate.entry, "requirement");
  const version = entry.x402Version ?? candidate.version;
  if (version !== 2) fail("x402Version", "must equal 2");
  if (entry.scheme !== "exact") fail("scheme", 'must equal "exact"');
  const rawNetwork = entry.network;
  if (rawNetwork !== BASE_NETWORK && rawNetwork !== "base") {
    fail("network", 'must equal "eip155:8453" or "base"');
  }

  const amount = entry.maxAmountRequired ?? entry.amount;
  if (typeof amount !== "string" || !DECIMAL_INTEGER.test(amount) || BigInt(amount) <= 0n) {
    fail("maxAmountRequired", "must be a positive decimal string");
  }
  if (typeof entry.asset !== "string" || !ADDRESS.test(entry.asset)) {
    fail("asset", "must be a 0x-prefixed 20-byte address");
  }
  if (typeof entry.payTo !== "string" || !ADDRESS.test(entry.payTo)) {
    fail("payTo", "must be a 0x-prefixed 20-byte address");
  }

  const resourceValue = entry.resource ?? candidate.resource;
  const resource = typeof resourceValue === "string" ? resourceValue : resourceValue?.url;
  const mimeType = entry.mimeType ?? resourceValue?.mimeType;
  if (typeof resource !== "string" || resource.length === 0) fail("resource", "must be present");
  if (typeof mimeType !== "string" || mimeType.length === 0) fail("mimeType", "must be present");
  if (entry.maxTimeoutSeconds === undefined || entry.maxTimeoutSeconds === null || entry.maxTimeoutSeconds === "") {
    fail("maxTimeoutSeconds", "must be present");
  }
  const maxTimeoutSeconds = Number(entry.maxTimeoutSeconds);
  if (!Number.isFinite(maxTimeoutSeconds) || maxTimeoutSeconds <= 0) {
    fail("maxTimeoutSeconds", "must be a positive number");
  }

  const canonicalEntry = {
    ...entry,
    scheme: "exact",
    network: BASE_NETWORK,
    amount,
    asset: entry.asset,
    payTo: entry.payTo,
    maxTimeoutSeconds,
    extra: entry.extra ?? {},
  };
  const paymentRequired = candidate.root?.accepts
    ? candidate.root
    : {
        x402Version: 2,
        resource: typeof resourceValue === "object"
          ? resourceValue
          : { url: resource, description: entry.description ?? "", mimeType },
        accepts: [canonicalEntry],
        extensions: candidate.root?.extensions ?? {},
      };

  return {
    x402Version: 2,
    scheme: "exact",
    network: BASE_NETWORK,
    maxAmountRequired: amount,
    maxAmountNormalized: amount,
    amount,
    asset: entry.asset,
    payTo: entry.payTo,
    resource,
    mimeType,
    maxTimeoutSeconds,
    raw: entry,
    paymentRequired,
  };
}

/**
 * Validate and normalize one exact-payment option from an x402 v2 response.
 * The deployed v2 `amount` spelling and the older `maxAmountRequired` spelling
 * are both normalized to `maxAmountNormalized` (USDC base units).
 *
 * Accepts both x402 v2 "exact" payment requirements in `accepts[]` format
 * (e.g. the deployed Penniless service) and legacy `paymentRequirements` format.
 */
export function parsePaymentRequirement(payload) {
  const object = asObject(payload);
  const candidates = paymentCandidates(object);
  if (candidates.length === 0) fail("payment requirement (accepts[] or paymentRequirements)", "must be present");

  let firstError;
  for (const candidate of candidates) {
    try {
      return validateCandidate(candidate);
    } catch (error) {
      firstError ??= error;
    }
  }
  throw firstError;
}

function usdcToBaseUnits(value) {
  const text = String(value);
  if (!/^[0-9]+(?:\.[0-9]+)?$/.test(text)) {
    throw new Error("priceToleranceUSDC must be a non-negative decimal with at most 6 places");
  }
  const [whole, fraction = ""] = text.split(".");
  if (fraction.length > 6) {
    throw new Error("priceToleranceUSDC must have at most 6 decimal places");
  }
  return BigInt(whole) * 1_000_000n + BigInt((fraction + "000000").slice(0, 6));
}

function assertWithinTolerance(requirement, toleranceBaseUnits) {
  if (BigInt(requirement.maxAmountNormalized) > toleranceBaseUnits) {
    throw new Error(
      `Refusing x402 payment: required ${requirement.maxAmountNormalized} USDC base units exceeds configured tolerance ${toleranceBaseUnits}`,
    );
  }
}

function validatePrivateKey(privateKey) {
  if (typeof privateKey !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
    throw new Error("privateKey must be a 0x-prefixed 32-byte hex string");
  }
  return privateKey;
}

/**
 * Read PDU_PRIVATE_KEY at call time and create a viem account. The environment
 * value is never logged, serialized, written to disk, or attached to the client.
 */
export async function accountFromEnv() {
  const privateKey = validatePrivateKey(globalThis.process?.env?.PDU_PRIVATE_KEY);
  const { privateKeyToAccount } = await import("viem/accounts");
  return privateKeyToAccount(privateKey);
}

function makeDefaultSignerAdapter({ privateKey, account, maxAmountBaseUnits }) {
  return {
    async sign(requirement) {
      const [{ x402Client, x402HTTPClient }, { registerExactEvmScheme }, { privateKeyToAccount }] = await Promise.all([
        import("@x402/core/client"),
        import("@x402/evm/exact/client"),
        import("viem/accounts"),
        // Keep @x402/fetch a lazy runtime dependency as required, while the
        // explicit one-retry implementation below remains adapter-testable.
        import("@x402/fetch"),
      ]);
      const signer = account ?? (privateKey
        ? privateKeyToAccount(validatePrivateKey(privateKey))
        : await accountFromEnv());
      const client = new x402Client();
      // @x402/core 2.25 defaults to recognized assets only. Our Base USDC
      // address can be treated as non-default by the scheme, so explicitly
      // allow only the already-validated challenge asset and cap it at the
      // caller's own USDC tolerance. This keeps the SDK's spend controls on
      // instead of disabling them globally.
      client.setSpendControls({
        allowedAssets: [{
          network: BASE_NETWORK,
          asset: requirement.asset,
          maxAmountPerPayment: String(maxAmountBaseUnits),
        }],
      });
      registerExactEvmScheme(client, { signer, networks: [BASE_NETWORK] });
      const httpClient = new x402HTTPClient(client);
      const payment = await httpClient.createPaymentPayload(requirement.paymentRequired);
      const protocolHeaders = httpClient.encodePaymentSignatureHeader(payment);
      const encoded = protocolHeaders["PAYMENT-SIGNATURE"] ?? protocolHeaders["X-PAYMENT"];
      return {
        payment,
        headers: {
          ...protocolHeaders,
          // Retain the requested compatibility name as well as the v2 header.
          "X-PAYMENT": encoded,
        },
      };
    },
  };
}

function normalizeSignedPayment(signed) {
  if (!signed || typeof signed !== "object" || Array.isArray(signed)) {
    throw new Error("signerAdapter.sign() must return a payment header object");
  }
  if (signed.payment && signed.headers) {
    return { payment: signed.payment, headers: signed.headers };
  }
  return {
    payment: signed,
    headers: { "X-PAYMENT": JSON.stringify(signed) },
  };
}

async function responseJson(response) {
  try {
    return await response.clone().json();
  } catch {
    throw new Error(`HTTP ${response.status}: response body is not valid JSON`);
  }
}

function decodeBase64Json(value) {
  try {
    return JSON.parse(Buffer.from(value, "base64").toString("utf8"));
  } catch {
    throw new Error("Invalid x402 payment requirement: PAYMENT-REQUIRED header must contain base64 JSON");
  }
}

async function requirementFromResponse(response) {
  let body;
  try {
    body = await response.clone().json();
    return parsePaymentRequirement(body);
  } catch (bodyError) {
    const encoded = response.headers.get("payment-required");
    if (encoded) return parsePaymentRequirement(decodeBase64Json(encoded));
    throw bodyError;
  }
}

async function resultJson(response) {
  const body = await responseJson(response);
  if (!response.ok) {
    const reason = typeof body?.error === "string" ? `: ${body.error}` : "";
    throw new Error(`HTTP ${response.status}${reason}`);
  }
  return body;
}

function mergeHeaders(headers, additions) {
  const merged = new Headers(headers);
  for (const [name, value] of Object.entries(additions)) merged.set(name, value);
  return merged;
}

function joinUrl(baseUrl, path) {
  if (/^https?:\/\//i.test(String(path))) return String(path);
  return new URL(String(path).replace(/^\//, ""), `${baseUrl}/`).toString();
}

function mcpRequirement(body) {
  try {
    return parsePaymentRequirement(body);
  } catch {
    return null;
  }
}

/** Create a paying Penniless Data Utilities REST and MCP client. */
export function createPennilessClient(options = {}) {
  const {
    baseUrl = DEFAULT_BASE_URL,
    privateKey,
    account,
    fetch: fetchImpl = globalThis.fetch,
    facilitator,
    signerAdapter,
    priceToleranceUSDC = DEFAULT_TOLERANCE_USDC,
  } = options;
  void facilitator; // Reserved for compatible custom adapters; clients do not settle.
  if (privateKey !== undefined) validatePrivateKey(privateKey);
  if (privateKey !== undefined && account !== undefined) {
    throw new Error("Provide either privateKey or account, not both");
  }
  if (typeof fetchImpl !== "function") throw new Error("fetch must be a function");
  if (signerAdapter !== undefined && typeof signerAdapter?.sign !== "function") {
    throw new Error("signerAdapter.sign must be a function");
  }
  const normalizedBaseUrl = String(baseUrl).replace(/\/+$/, "");
  const toleranceBaseUnits = usdcToBaseUnits(priceToleranceUSDC);
  const adapter = signerAdapter ?? makeDefaultSignerAdapter({ privateKey, account, maxAmountBaseUnits: toleranceBaseUnits });

  const rawFetch = async (path, init = {}) => {
    const url = joinUrl(normalizedBaseUrl, path);
    const first = await fetchImpl(url, init);
    if (first.status !== 402) return first;
    // x402 v2 carries PAYMENT-REQUIRED in a base64 response header. Some
    // compatible services also duplicate it in the JSON body, so accept both.
    const requirement = await requirementFromResponse(first);
    assertWithinTolerance(requirement, toleranceBaseUnits);
    const signed = normalizeSignedPayment(await adapter.sign(requirement));
    return fetchImpl(url, { ...init, headers: mergeHeaders(init.headers, signed.headers) });
  };

  const paidPost = async (path, body) => resultJson(await rawFetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));

  const freeRequest = async (path, init) => resultJson(await fetchImpl(joinUrl(normalizedBaseUrl, path), init));

  const tools = {
    repairJson: (input) => paidPost(TOOL_PATHS.repairJson, { input }),
    yamlToJson: (input) => paidPost(TOOL_PATHS.yamlToJson, { input }),
    cronNextRun: (expr, after) => paidPost(TOOL_PATHS.cronNextRun, after === undefined ? { expr } : { expr, after }),
    textDiff: (old, newText, context) => paidPost(TOOL_PATHS.textDiff, context === undefined ? { old, new: newText } : { old, new: newText, context }),
    textExtract: (input, opts = {}) => paidPost(TOOL_PATHS.textExtract, { input, ...opts }),
    domainWhois: (domain) => paidPost(TOOL_PATHS.domainWhois, { domain }),
    dnsLookup: (domain, type) => paidPost(TOOL_PATHS.dnsLookup, type === undefined ? { domain } : { domain, type }),
    githubRepoStats: (repo) => paidPost(TOOL_PATHS.githubRepoStats, { repo }),
    cryptoPrice: (symbols) => paidPost(TOOL_PATHS.cryptoPrice, { symbols }),
    emailValidate: (email) => paidPost(TOOL_PATHS.emailValidate, { email }),
  };

  let mcpId = 0;
  const mcp = {
    async tool(name, args = {}) {
      const requestBody = {
        jsonrpc: "2.0",
        id: ++mcpId,
        method: "tools/call",
        params: { name, arguments: args },
      };
      const url = joinUrl(normalizedBaseUrl, "/mcp");
      const init = {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify(requestBody),
      };
      const first = await fetchImpl(url, init);
      if (!first.ok) return resultJson(first);
      const firstBody = await responseJson(first);
      const requirement = mcpRequirement(firstBody);
      if (!requirement) return firstBody?.result ?? firstBody;
      assertWithinTolerance(requirement, toleranceBaseUnits);
      const signed = normalizeSignedPayment(await adapter.sign(requirement));
      requestBody.params._meta = { "x402/payment": signed.payment };
      const retry = await fetchImpl(url, { ...init, body: JSON.stringify(requestBody) });
      const retryBody = await resultJson(retry);
      return retryBody?.result ?? retryBody;
    },
  };

  const client = {
    tools,
    mcp,
    health: () => freeRequest("/health", { method: "GET" }),
    stats: () => freeRequest("/stats", { method: "GET" }),
    diagnose: (input) => freeRequest("/diagnose", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input }),
    }),
    rawFetch,
  };
  Object.defineProperty(client, INSPECT_CUSTOM, {
    enumerable: false,
    value: () => "PennilessClient { tools, mcp, health, stats, diagnose, rawFetch, credentials: [REDACTED] }",
  });
  return client;
}

export { TOOL_PATHS };
