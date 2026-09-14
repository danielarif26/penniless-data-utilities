import { Hono } from "hono";
import { cors } from "hono/cors";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { mpp as mppPaymentMiddleware } from "mppx/x402/hono";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import {
  TOOLS, ACCEPTS, ORIGIN, PAY_TO, NETWORK, FACILITATOR, PRICE, PRICE_USD, SEMANTIC,
  validateArgs,
} from "./shared.js";
import { createMcpHandler } from "./mcp.js";

const facilitatorClient = new HTTPFacilitatorClient({ url: FACILITATOR });
const resourceServer = new x402ResourceServer(facilitatorClient)
  .register(NETWORK, new ExactEvmScheme());

// Cloudflare Workers forbid network I/O during module init. x402 normally syncs
// the facilitator eagerly, so initialize it lazily on the first protected request.
let resourceInitPromise = null;
let resourceInitialized = false;
async function ensureResourceServerInitialized() {
  if (resourceInitialized) return true;
  if (!resourceInitPromise) {
    resourceInitPromise = resourceServer.initialize()
      .then(() => { resourceInitialized = true; return true; })
      .catch((error) => { resourceInitPromise = null; throw error; });
  }
  try {
    await resourceInitPromise;
    return true;
  } catch (error) {
    console.error("x402 facilitator initialization failed", error);
    return false;
  }
}

// Counters are deliberately kept outside the request path. They are telemetry,
// never a precondition for serving or settling a payment.
const COUNTER_SCHEMA = `
  CREATE TABLE IF NOT EXISTS endpoint_counters (
    endpoint TEXT PRIMARY KEY,
    requests INTEGER NOT NULL DEFAULT 0,
    paid_attempts INTEGER NOT NULL DEFAULT 0,
    settled_success INTEGER NOT NULL DEFAULT 0,
    free_requests INTEGER NOT NULL DEFAULT 0,
    first_seen TEXT NOT NULL,
    last_seen TEXT NOT NULL
  )
`;
const COUNTER_UPSERT = `
  INSERT INTO endpoint_counters (
    endpoint, requests, paid_attempts, settled_success, free_requests, first_seen, last_seen
  ) VALUES (?, 1, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  ON CONFLICT(endpoint) DO UPDATE SET
    requests = requests + 1,
    paid_attempts = paid_attempts + excluded.paid_attempts,
    settled_success = settled_success + excluded.settled_success,
    free_requests = free_requests + excluded.free_requests,
    last_seen = CURRENT_TIMESTAMP
`;
let countersInitPromise = null;
let countersInitDatabase = null;

function ensureCountersInitialized(db) {
  if (!db?.prepare) return Promise.resolve(false);
  if (countersInitDatabase === db && countersInitPromise) return countersInitPromise;
  countersInitDatabase = db;
  countersInitPromise = db.prepare(COUNTER_SCHEMA).run()
    .then(() => true)
    .catch((error) => {
      if (countersInitDatabase === db) {
        countersInitDatabase = null;
        countersInitPromise = null;
      }
      throw error;
    });
  return countersInitPromise;
}

const FREE_COUNTER_PATHS = new Set([
  "/health",
  "/diagnose",
  "/stats",
  "/.well-known/402index-verify.txt",
]);
const TRACKED_COUNTER_PATHS = [
  ...Object.keys(TOOLS),
  "/mcp",
  ...FREE_COUNTER_PATHS,
];

export function hasSettlementResponse(response) {
  // x402 v2 attaches Payment-Response; native MPP attaches Payment-Receipt.
  // Either header is settlement evidence. A bare HTTP 402/WWW-Authenticate is not.
  return response.headers.has("payment-response") || response.headers.has("payment-receipt");
}

function parseMcpResponsePayloads(body) {
  const payloads = [];
  try {
    payloads.push(JSON.parse(body));
    return payloads;
  } catch {
    // Streamable HTTP may send JSON-RPC results as SSE: each event's data
    // field is still JSON, and a response can contain more than one event.
    for (const event of body.split(/\r?\n\r?\n/)) {
      const data = event.split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (!data) continue;
      try {
        payloads.push(JSON.parse(data));
      } catch {
        // Ignore non-JSON SSE events (for example, a keepalive).
      }
    }
  }
  return payloads;
}

async function mcpCounterFlags(request, response) {
  const flags = { endpoint: "/mcp", paidAttempt: 0, settledSuccess: 0, freeRequest: 0 };
  try {
    const requestBody = await request.json();
    if (requestBody?.method === "tools/list") {
      flags.freeRequest = 1;
      return flags;
    }
    if (requestBody?.method !== "tools/call") return flags;

    const tool = Object.entries(TOOLS).find(([, value]) => value.mcpName === requestBody?.params?.name);
    if (!tool) return flags;
    flags.endpoint = tool[0];
    // An MCP tools/call maps to its matching paid REST endpoint. Unlike REST,
    // its payment-required result is JSON-RPC 200, so the attempt is known from
    // the call itself rather than an HTTP 402 status.
    flags.paidAttempt = 1;

    const payloads = parseMcpResponsePayloads(await response.text());
    flags.settledSuccess = response.status >= 200 && response.status < 300
      && payloads.some((body) => {
        const result = body?.result ?? body;
        const settlement = result?._meta?.["x402/payment-response"];
        return result?.isError !== true && settlement?.success === true;
      })
      ? 1
      : 0;
  } catch (error) {
    // A transport body that cannot be read is still counted as a request below.
    console.error("MCP counter classification failed", error);
  }
  return flags;
}

async function recordCounter(db, path, response, mcpRequest, mcpResponse) {
  if (!db?.prepare) return;

  let endpoint = path;
  let settledSuccess = response.status >= 200 && response.status < 300 && hasSettlementResponse(response) ? 1 : 0;
  let paidAttempt = Object.hasOwn(TOOLS, path) && (response.status === 402 || settledSuccess) ? 1 : 0;
  let freeRequest = FREE_COUNTER_PATHS.has(path) ? 1 : 0;
  if (path === "/mcp") ({ endpoint, paidAttempt, settledSuccess, freeRequest } = await mcpCounterFlags(mcpRequest, mcpResponse));

  await ensureCountersInitialized(db);
  await db.prepare(COUNTER_UPSERT)
    .bind(endpoint, paidAttempt, settledSuccess, freeRequest)
    .run();
}

function scheduleCounter(c, path, response, mcpRequest) {
  try {
    const mcpResponse = path === "/mcp" ? response.clone() : null;
    // Defer starting even the schema check until after the response exists.
    const write = Promise.resolve()
      .then(() => recordCounter(c.env?.DB, path, response, mcpRequest, mcpResponse))
      .catch((error) => console.error("D1 counter write failed", error));

    // app.fetch() in Node tests does not have an execution context; retaining
    // the promise there keeps the request behavior identical while Workers
    // uses the native background-task mechanism.
    try {
      c.executionCtx.waitUntil(write);
    } catch {
      void write;
    }
  } catch (error) {
    console.error("D1 counter scheduling failed", error);
  }
}

function isCounterPath(path) {
  return TRACKED_COUNTER_PATHS.includes(path);
}

function emptyCounter() {
  return {
    requests: 0,
    paid_attempts: 0,
    settled_success: 0,
    free_requests: 0,
    first_seen: null,
    last_seen: null,
  };
}

async function readCounters(db) {
  const rows = [];
  if (db?.prepare) {
    try {
      await ensureCountersInitialized(db);
      const result = await db.prepare(`
        SELECT endpoint, requests, paid_attempts, settled_success, free_requests, first_seen, last_seen
        FROM endpoint_counters
      `).all();
      rows.push(...(result.results ?? []));
    } catch (error) {
      // /stats remains a free, available health surface if D1 is temporarily down.
      console.error("D1 counter read failed", error);
    }
  }

  const byEndpoint = Object.fromEntries(TRACKED_COUNTER_PATHS.map((path) => [path, emptyCounter()]));
  const counters = { total_requests: 0, paid_attempts: 0, settled_success: 0, free_requests: 0 };
  for (const row of rows) {
    const requests = Number(row.requests) || 0;
    const paidAttempts = Number(row.paid_attempts) || 0;
    const settledSuccess = Number(row.settled_success) || 0;
    const freeRequests = Number(row.free_requests) || 0;
    counters.total_requests += requests;
    counters.paid_attempts += paidAttempts;
    counters.settled_success += settledSuccess;
    counters.free_requests += freeRequests;
    byEndpoint[row.endpoint] = {
      requests,
      paid_attempts: paidAttempts,
      settled_success: settledSuccess,
      free_requests: freeRequests,
      first_seen: row.first_seen,
      last_seen: row.last_seen,
    };
  }
  return { counters, byEndpoint };
}

const routes = {};
for (const [path, t] of Object.entries(TOOLS)) {
  routes[`* ${path}`] = {
    accepts: ACCEPTS,
    description: t.desc,
    mimeType: "application/json",
    serviceName: t.serviceName,
    tags: t.tags,
    // Keep the payment challenge extension-free so the official mppx x402
    // compatibility negotiator can faithfully expose the same EIP-3009 offer
    // over both MPP and x402. Discovery metadata remains in OpenAPI/well-known.
  };
}

const app = new Hono();

// Browser clients must be able to complete CORS preflight before negotiating a
// payment. In particular, OPTIONS must never be paywalled, and the payment
// challenge/settlement headers must be readable by cross-origin clients.
app.use("*", cors({
  origin: "*",
  allowMethods: ["GET", "HEAD", "POST", "PUT", "DELETE", "OPTIONS"],
  allowHeaders: ["Content-Type", "Payment-Signature", "X-PAYMENT", "Authorization"],
  exposeHeaders: ["PAYMENT-REQUIRED", "PAYMENT-RESPONSE", "WWW-Authenticate", "Payment-Receipt"],
  maxAge: 86400,
}));

// This is registered before x402 so it observes both 402 requirements and the
// final settled response, while the D1 work itself runs only after the response
// has been produced.
app.use("*", async (c, next) => {
  // The request clone is made before the transport reads its JSON-RPC body; it
  // is only parsed by the deferred counter task after the response is ready.
  let mcpRequest = null;
  if (c.req.path === "/mcp") {
    try {
      mcpRequest = c.req.raw.clone();
    } catch (error) {
      console.error("MCP counter request clone failed", error);
    }
  }
  await next();
  const path = c.req.path;
  if (isCounterPath(path)) scheduleCounter(c, path, c.res, mcpRequest);
});

for (const path of Object.keys(TOOLS)) {
  app.use(path, async (c, next) => {
    if (!(await ensureResourceServerInitialized())) {
      return c.json({ ok: false, error: "x402 facilitator unavailable" }, 503);
    }
    return next();
  });
}

const x402OnlyMiddleware = paymentMiddleware(routes, resourceServer, undefined, undefined, false);
let dualRailMiddleware = null;
let dualRailSecret = null;

app.use("*", async (c, next) => {
  const secret = c.env?.MPP_SECRET_KEY;
  if (!secret) return x402OnlyMiddleware(c, next);
  if (String(secret).length < 32) {
    return c.json({ ok: false, error: "MPP server secret is misconfigured" }, 503);
  }
  if (!dualRailMiddleware || dualRailSecret !== secret) {
    dualRailSecret = secret;
    dualRailMiddleware = mppPaymentMiddleware(routes, resourceServer, {
      secretKey: secret,
      realm: new URL(ORIGIN).host,
    });
  }
  return dualRailMiddleware(c, next);
});

for (const path of Object.keys(TOOLS)) {
  app.post(path, async (c) => {
    let body;
    try { body = await c.req.json(); }
    catch { return c.json({ ok: false, error: "request body must be JSON" }, 400); }
    const tool = TOOLS[path];
    const bad = validateArgs(tool.schema, body);
    if (bad) return c.json({ ok: false, error: bad }, 400);
    const result = await tool.handler(body);
    // x402 settles only after a successful (<400) handler response. A tool-level
    // failure must therefore be an HTTP error as well as `{ ok: false }`, or a
    // caller can be charged for a failed operation.
    return c.json(result, result?.ok === false ? 422 : 200);
  });
}

// MCP over streamable HTTP: the same nine tools, same price, same wallet.
// Listing is free to call; only tools/call carries the payment requirement.
app.post("/mcp", async (c) => {
  if (!(await ensureResourceServerInitialized())) {
    return c.json({ jsonrpc: "2.0", error: { code: -32603, message: "x402 facilitator unavailable" }, id: null }, 503);
  }
  try {
    const handle = await createMcpHandler(resourceServer);
    return await handle(c.req.raw);
  } catch (error) {
    console.error("mcp request failed", error);
    return c.json({ jsonrpc: "2.0", error: { code: -32603, message: "MCP request failed" }, id: null }, 500);
  }
});

app.get("/health", (c) => c.json({
  ok: true, x402Version: 2, mppRestEnabled: Boolean(c.env?.MPP_SECRET_KEY), network: NETWORK, price: PRICE, facilitator: FACILITATOR,
  endpoints: Object.keys(TOOLS), mcp: `${ORIGIN}/mcp`,
}));
app.get("/stats", async (c) => {
  const { counters, byEndpoint } = await readCounters(c.env?.DB);
  return c.json({
    ok: true,
    price: PRICE,
    paid: true,
    endpoints: Object.keys(TOOLS),
    counters,
    by_endpoint: byEndpoint,
    note: "counters persisted via D1",
  });
});

// Free preview: classify what's wrong without returning the repaired payload.
app.post("/diagnose", async (c) => {
  let body;
  try { body = await c.req.json(); }
  catch { return c.json({ ok: false, error: "request body must be JSON" }, 400); }
  const bad = validateArgs(TOOLS["/repair/json"].schema, body);
  if (bad) return c.json({ ok: false, error: bad }, 400);
  const input = body.input;
  const problems = [];
  if (/```/.test(input)) problems.push("markdown_fences");
  if (/,\s*[}\]]/.test(input)) problems.push("trailing_commas");
  if (/(?<![\w"])'(?:[^'\\]|\\.)*'/.test(input)) problems.push("single_quoted_strings");
  if (/\b(True|False|None|NaN|Infinity)\b/.test(input)) problems.push("python_literals");
  if (/(^|[,{\s])([A-Za-z_$][\w$]*)\s*:/.test(input.replace(/"[^"\\]*"/g, ""))) problems.push("unquoted_keys");
  if (/\/\/|\/\*|\*\//.test(input.replace(/"[^"\\]*"/g, ""))) problems.push("comments");
  let parsesNow = true;
  try { JSON.parse(input); } catch { parsesNow = false; }
  return c.json({ ok: true, parsesNow, inputBytes: input.length, problems, paidRepair: `POST /repair/json at ${PRICE} via x402 (USDC on Base)` });
});

// Static domain-verification token published by 402index.io for instant approval.
// It is public by design (served at /.well-known/) and carries no authority.
app.get("/.well-known/402index-verify.txt", (c) =>
  c.text("b32507a03d228eb51199ec7fed5842e4bc2d1aed8b062557310d5a676b90d67b\n", 200, {
    "Content-Type": "text/plain; charset=utf-8",
  }));

app.get("/.well-known/x402", (c) => c.json({
  version: 1,
  x402Version: 2,
  name: "Penniless Data Utilities",
  description: SEMANTIC,
  openapi: `${ORIGIN}/openapi.json`,
  llms: `${ORIGIN}/llms.txt`,
  mcp: `${ORIGIN}/mcp`,
  // MPP (Machine Payments Protocol) server info for MPPscan discovery
  mpp: {
    enabled: Boolean(c.env?.MPP_SECRET_KEY),
    paymentServer: {
      scheme: "exact",
      network: NETWORK,
      payTo: PAY_TO,
      price: PRICE,
      asset: "USDC",
      assetAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    },
  },
  resources: [
    ...Object.entries(TOOLS).map(([path, t]) => ({
      url: `${ORIGIN}${path}`, method: "POST", description: t.desc,
      accepts: [ACCEPTS],
    })),
    {
      url: `${ORIGIN}/diagnose`, method: "POST",
      description: "Free preview: classifies what is wrong with a malformed JSON payload without returning the repaired output.",
      accepts: [],
    },
  ],
}));

app.get("/llms.txt", (c) => c.text(`${ORIGIN} - Penniless Data Utilities

All paid endpoints: x402 v2 / MPP, ${PRICE} USDC on Base (eip155:8453), payTo ${PAY_TO}.

MCP (streamable HTTP): ${ORIGIN}/mcp - the same nine tools over x402 v2, priced per tools/call.

Paid:
  POST /repair/json       {input}       -> {ok, repaired, applied}   malformed LLM JSON -> valid JSON
  POST /yaml/tojson       {input}       -> {ok, value, warnings}     YAML subset -> JSON
  POST /cron/nextrun      {expr,after}  -> {ok, next, epochMs}       next UTC cron fire time
  POST /diff              {old,new}     -> {ok, added, removed, unified}
  POST /text/extract      {input}       -> {ok, title, headings, links, urls, emails, text}
  POST /domain/whois      {domain}      -> {ok, found, registrar, status, events, nameservers, dnssec}
  POST /dns/lookup        {domain,type} -> {ok, status, answers}     A AAAA CNAME MX TXT NS SOA PTR SRV CAA
  POST /github/repo-stats {repo}        -> {ok, found, stars, forks, openIssues, language, license, pushedAt}
  POST /email/validate    {email}       -> {ok, valid, formatValid, domainHasMx, mx}

Free:
  POST /diagnose      {input}      -> {parsesNow, problems[]}   JSON problem classifier

Payment discovery:
  x402 v2:      ${ORIGIN}/.well-known/x402
  MPP Bazaar:   Enable via x402 discovery - same endpoint
  MPPscan:      Discover at ${ORIGIN}/.well-known/x402
`));

app.get("/openapi.json", (c) => {
  const paths = {};
  for (const [path, t] of Object.entries(TOOLS)) {
    paths[path] = {
      post: {
        summary: t.serviceName,
        description: t.desc,
        "x-payment-info": { price: { mode: "fixed", currency: "USD", amount: PRICE_USD }, protocols: [{ x402: {} }, { mpp: {} }] },
        requestBody: { required: true, content: { "application/json": { schema: t.schema } } },
        responses: {
          "200": { description: "Result.", content: { "application/json": { schema: { type: "object" } } } },
          "400": { description: "Invalid request body." },
          "402": { description: "Payment required (x402 v2 / MPP)." },
          "413": { description: "Input exceeds maxBytes." },
        },
      },
    };
  }
  paths["/diagnose"] = { post: { summary: "Free JSON problem classifier", description: "Free pre-check before paying for /repair/json.", requestBody: { required: true, content: { "application/json": { schema: { type: "object" } } } }, responses: { "200": { description: "ok" } } } };
  paths["/health"] = { get: { summary: "Liveness + config", responses: { "200": { description: "ok" } } } };
  paths["/mcp"] = { post: { summary: "MCP streamable HTTP transport", description: `Model Context Protocol endpoint exposing the same tools over x402 v2. Per-call price ${PRICE} USDC on Base.`, responses: { "200": { description: "JSON-RPC response." }, "402": { description: "Payment required (x402 v2)." } } } };
  return c.json({
    openapi: "3.1.0",
    info: {
      title: "Penniless Data Utilities",
      description: SEMANTIC,
      version: "3.1.0",
      "x-guidance": "Deterministic data and lookup tools for agents. Use /repair/json when JSON.parse rejects near-JSON from an LLM; /yaml/tojson to turn YAML config into JSON; /cron/nextrun to resolve a cron schedule; /diff to compare two texts; /text/extract to pull links/emails/headings from HTML; /domain/whois and /dns/lookup for domain registration and DNS records; /github/repo-stats for repository popularity; /email/validate to check syntax plus MX deliverability. Call the REST paths directly over x402 v2 or native MPP, or connect an MCP client to /mcp over x402 v2. Paid REST endpoints return HTTP 402 advertising both rails; MCP tools/call uses x402 v2. /diagnose and /health are free.",
      "x-payment-server": {
        scheme: "exact",
        network: NETWORK,
        payTo: PAY_TO,
        price: PRICE,
        asset: "USDC",
        assetAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        mpp: { enabled: Boolean(c.env?.MPP_SECRET_KEY) },
      },
    },
    servers: [{ url: ORIGIN }],
    paths,
  });
});

export default app;
