import { Hono } from "hono";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";
import {
  TOOLS, ORIGIN, PAY_TO, NETWORK, FACILITATOR, COMPUTE_PRICE, NETWORK_PRICE,
  USDC_BASE, SEMANTIC, COMPUTE_TOOL_PATHS, validateArgs,
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
const PAYMENT_LIFECYCLE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS payment_lifecycle_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    occurred_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    route TEXT NOT NULL,
    outcome TEXT NOT NULL CHECK (outcome IN (
      'challenge_issued', 'settled_success', 'verify_failed',
      'facilitator_error', 'handler_failed'
    )),
    payer_class TEXT NOT NULL CHECK (payer_class IN (
      'no_payment_header', 'payment_header_present_unsettled',
      'settled_external', 'settled_self'
    )),
    client_class TEXT NOT NULL CHECK (client_class IN (
      'known_crawler', 'agent_client', 'browser', 'unknown'
    ))
  )
`;
const PAYMENT_LIFECYCLE_INDEX = `
  CREATE INDEX IF NOT EXISTS payment_lifecycle_events_summary
    ON payment_lifecycle_events (outcome, payer_class)
`;
const FREE_TRIAL_SCHEMA = `
  CREATE TABLE IF NOT EXISTS free_trial_allowances (
    client_hash TEXT PRIMARY KEY,
    last_success_at TEXT,
    reservation_id TEXT,
    reservation_at TEXT
  );
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
    .then(() => db.prepare(PAYMENT_LIFECYCLE_SCHEMA).run())
    .then(() => db.prepare(PAYMENT_LIFECYCLE_INDEX).run())
    .then(() => db.prepare(FREE_TRIAL_SCHEMA).run())
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
  "/",
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
  // x402 v2 attaches Payment-Response; compatible paid transports may attach Payment-Receipt.
  // Either receipt header is settlement evidence. A bare HTTP 402/WWW-Authenticate is not.
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
  let freeRequest = FREE_COUNTER_PATHS.has(path) || response.headers.get("x-free-trial") === "true" ? 1 : 0;
  if (path === "/mcp") ({ endpoint, paidAttempt, settledSuccess, freeRequest } = await mcpCounterFlags(mcpRequest, mcpResponse));

  await ensureCountersInitialized(db);
  await db.prepare(COUNTER_UPSERT)
    .bind(endpoint, paidAttempt, settledSuccess, freeRequest)
    .run();
}

function clientClass(userAgent) {
  const ua = (userAgent ?? "").toLowerCase();
  if (/(googlebot|bingbot|yandexbot|baiduspider|duckduckbot|slurp|facebookexternalhit)/.test(ua)) return "known_crawler";
  if (/(mcp|agent|bot|crawler|python-requests|curl|axios|node-fetch|go-http-client)/.test(ua)) return "agent_client";
  if (/(mozilla|safari|chrome|firefox|edg\/)/.test(ua)) return "browser";
  return "unknown";
}

function paymentHeader(request) {
  return request?.headers?.get("payment-signature")
    ?? request?.headers?.get("x-payment")
    ?? request?.headers?.get("payment");
}

function payerAddressFromPayment(value) {
  if (!value) return null;
  try {
    const decoded = JSON.parse(atob(value.replace(/-/g, "+").replace(/_/g, "/")));
    return decoded?.payload?.authorization?.from?.toLowerCase() ?? null;
  } catch {
    return null;
  }
}

function mcpCallDetails(body) {
  if (body?.method !== "tools/call") return null;
  const path = Object.entries(TOOLS)
    .find(([, tool]) => tool.mcpName === body?.params?.name)?.[0];
  if (!path) return null;
  const payment = body?.params?._meta?.["x402/payment"];
  return {
    path,
    carriesPayment: Boolean(payment),
    payer: payment?.payload?.authorization?.from?.toLowerCase() ?? null,
  };
}

function mcpResponseResult(body) {
  const payloads = parseMcpResponsePayloads(body);
  return payloads.map((payload) => payload?.result ?? payload);
}

async function recordLifecycleEvent(db, path, response, request, handlerFailed = false) {
  if (!db?.prepare || (!Object.hasOwn(TOOLS, path) && path !== "/mcp")) return;
  const isMcp = path === "/mcp";
  let carriesPayment = Boolean(paymentHeader(request));
  let payer = null;
  if (isMcp) {
    let body;
    try {
      body = await request?.json();
    } catch {
      return;
    }
    const call = mcpCallDetails(body);
    // MCP initialization, tools/list, and unknown tools are not paid service
    // invocations, so do not mix them into the payment lifecycle.
    if (!call) return;
    path = call.path;
    carriesPayment = call.carriesPayment;
    payer = call.payer;
  }

  let outcome;
  if (response.status === 402) outcome = carriesPayment ? "verify_failed" : "challenge_issued";
  else if (handlerFailed || response.status === 422) outcome = "handler_failed";
  else if (response.status >= 500) outcome = "facilitator_error";
  else if (
    response.status >= 200
    && response.status < 300
    && (hasSettlementResponse(response)
      || (isMcp && mcpResponseResult(await response.clone().text())
        .some((result) => result?.isError !== true && result?._meta?.["x402/payment-response"]?.success === true)))
  ) outcome = "settled_success";
  // An MCP tools/call with no payment is represented as a JSON-RPC 200 error,
  // rather than HTTP 402. It is still an unpaid payment challenge.
  else if (isMcp && !carriesPayment) outcome = "challenge_issued";
  else return;

  let payerClass = carriesPayment ? "payment_header_present_unsettled" : "no_payment_header";
  if (outcome === "settled_success") {
    payer ??= payerAddressFromPayment(paymentHeader(request));
    payerClass = payer === PAY_TO.toLowerCase() ? "settled_self" : "settled_external";
  }
  await ensureCountersInitialized(db);
  await db.prepare(`
    INSERT INTO payment_lifecycle_events (route, outcome, payer_class, client_class)
    VALUES (?, ?, ?, ?)
  `).bind(path, outcome, payerClass, clientClass(request?.headers?.get("user-agent"))).run();
}

async function readLifecycleSummary(db) {
  const byOutcome = {};
  const byPayerClass = {};
  const byOutcomeAndPayerClass = {};
  if (!db?.prepare) {
    return {
      by_outcome: byOutcome,
      by_payer_class: byPayerClass,
      by_outcome_and_payer_class: byOutcomeAndPayerClass,
    };
  }
  try {
    await ensureCountersInitialized(db);
    const result = await db.prepare(`
      SELECT outcome, payer_class, COUNT(*) AS count
      FROM payment_lifecycle_events
      GROUP BY outcome, payer_class
    `).all();
    for (const row of result.results ?? []) {
      const count = Number(row.count) || 0;
      byOutcome[row.outcome] = (byOutcome[row.outcome] ?? 0) + count;
      byPayerClass[row.payer_class] = (byPayerClass[row.payer_class] ?? 0) + count;
      byOutcomeAndPayerClass[`${row.outcome}:${row.payer_class}`] = count;
    }
  } catch (error) {
    console.error("D1 lifecycle summary read failed", error);
  }
  return {
    by_outcome: byOutcome,
    by_payer_class: byPayerClass,
    by_outcome_and_payer_class: byOutcomeAndPayerClass,
  };
}

function scheduleCounter(c, path, response, mcpRequest) {
  try {
    const mcpResponse = path === "/mcp" ? response.clone() : null;
    const mcpLifecycleRequest = path === "/mcp" ? mcpRequest?.clone() : null;
    // Defer starting even the schema check until after the response exists.
    const write = Promise.resolve()
      .then(() => recordCounter(c.env?.DB, path, response, mcpRequest, mcpResponse))
      .catch((error) => console.error("D1 counter write failed", error));
    const lifecycleRequest = path === "/mcp" ? mcpLifecycleRequest : c.req.raw;
    const lifecycle = Promise.resolve()
      .then(() => recordLifecycleEvent(
        c.env?.DB, path, response, lifecycleRequest, Boolean(c.get("handlerFailed")),
      ))
      .catch((error) => console.error("D1 lifecycle event write failed", error));

    // app.fetch() in Node tests does not have an execution context; retaining
    // the promise there keeps the request behavior identical while Workers
    // uses the native background-task mechanism.
    try {
      c.executionCtx.waitUntil(Promise.all([write, lifecycle]));
    } catch {
      void write;
      void lifecycle;
    }
  } catch (error) {
    console.error("D1 counter scheduling failed", error);
  }
}

async function stableClientHash(c) {
  const ip = c.req.header("cf-connecting-ip");
  const salt = c.env?.FREE_TRIAL_SALT;
  if (!salt || !ip) return null;
  const input = new TextEncoder().encode(`${salt}:${ip}:${clientClass(c.req.header("user-agent"))}`);
  const digest = await crypto.subtle.digest("SHA-256", input);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function reserveFreeTrial(db, clientHash, reservationId) {
  if (!db?.prepare) return false;
  await ensureCountersInitialized(db);
  await db.prepare(`
    INSERT INTO free_trial_allowances (client_hash, reservation_id, reservation_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(client_hash) DO UPDATE SET
      reservation_id = excluded.reservation_id,
      reservation_at = CURRENT_TIMESTAMP
    WHERE (last_success_at IS NULL OR last_success_at <= datetime('now', '-1 day'))
      AND (reservation_at IS NULL OR reservation_at <= datetime('now', '-5 minutes'))
  `).bind(clientHash, reservationId).run();
  const result = await db.prepare(`
    SELECT reservation_id FROM free_trial_allowances
    WHERE client_hash = ? AND reservation_id = ?
  `).bind(clientHash, reservationId).first();
  return Boolean(result);
}

async function finishFreeTrial(db, clientHash, reservationId, success) {
  if (!db?.prepare) return;
  const statement = success
    ? `UPDATE free_trial_allowances
       SET last_success_at = CURRENT_TIMESTAMP, reservation_id = NULL, reservation_at = NULL
       WHERE client_hash = ? AND reservation_id = ?`
    : `UPDATE free_trial_allowances
       SET reservation_id = NULL, reservation_at = NULL
       WHERE client_hash = ? AND reservation_id = ?`;
  await db.prepare(statement).bind(clientHash, reservationId).run();
}

function isCounterPath(path) {
  return TRACKED_COUNTER_PATHS.includes(path);
}

function mayRequestFreeTrial(c) {
  return c.req.method === "POST"
    && COMPUTE_TOOL_PATHS.includes(c.req.path)
    && !paymentHeader(c.req.raw)
    && c.req.header("x-penniless-free-trial") !== "off"
    && Boolean(c.req.header("cf-connecting-ip"))
    && Boolean(c.env?.FREE_TRIAL_SALT)
    && Boolean(c.env?.DB?.prepare);
}

function emptyCounter() {
  return {
    requests: 0,
    paid_attempts: 0,
    payment_challenges: 0,
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
  const counters = { total_requests: 0, paid_attempts: 0, payment_challenges: 0, settled_success: 0, free_requests: 0 };
  for (const row of rows) {
    const requests = Number(row.requests) || 0;
    const paidAttempts = Number(row.paid_attempts) || 0;
    const settledSuccess = Number(row.settled_success) || 0;
    const paymentChallenges = Math.max(paidAttempts - settledSuccess, 0);
    const freeRequests = Number(row.free_requests) || 0;
    counters.total_requests += requests;
    counters.paid_attempts += paidAttempts;
    counters.payment_challenges += paymentChallenges;
    counters.settled_success += settledSuccess;
    counters.free_requests += freeRequests;
    byEndpoint[row.endpoint] = {
      requests,
      paid_attempts: paidAttempts,
      payment_challenges: paymentChallenges,
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
  // Put the callable POST route first so Bazaar indexes the real tool contract.
  routes[`POST ${path}`] = {
    accepts: t.accepts,
    description: t.desc,
    mimeType: "application/json",
    serviceName: t.serviceName,
    tags: t.tags,
    extensions: declareDiscoveryExtension({
      method: "POST",
      bodyType: "json",
      input: t.input,
      inputSchema: t.schema,
      output: { example: t.out },
    }),
  };
  // Keep all other methods payment-protected, but do not advertise them as callable tools.
  routes[`* ${path}`] = {
    accepts: t.accepts,
    description: t.desc,
    mimeType: "application/json",
    serviceName: t.serviceName,
    tags: t.tags,
  };
}

const app = new Hono();

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
    if (mayRequestFreeTrial(c)) return next();
    if (!(await ensureResourceServerInitialized())) {
      return c.json({ ok: false, error: "x402 facilitator unavailable" }, 503);
    }
    return next();
  });
}

const x402OnlyMiddleware = paymentMiddleware(routes, resourceServer, undefined, undefined, false);
// Keep REST payments on x402 only. The native MPP middleware settles before the
// protected tool handler runs, which can charge a request that later fails.
app.use("*", async (c, next) => {
  if (mayRequestFreeTrial(c)) {
    try {
      const clientHash = await stableClientHash(c);
      const reservationId = crypto.randomUUID();
      if (clientHash && await reserveFreeTrial(c.env.DB, clientHash, reservationId)) {
        c.set("freeTrial", { clientHash, reservationId });
        return next();
      }
    } catch (error) {
      // D1 trouble must not turn a paid route into an unbounded free route.
      console.error("free trial allowance check failed", error);
    }
    if (!(await ensureResourceServerInitialized())) {
      return c.json({ ok: false, error: "x402 facilitator unavailable" }, 503);
    }
  }
  return x402OnlyMiddleware(c, next);
});

for (const path of Object.keys(TOOLS)) {
  app.post(path, async (c) => {
    const freeTrial = c.get("freeTrial");
    const finishTrial = async (success) => {
      if (freeTrial) {
        try {
          await finishFreeTrial(c.env.DB, freeTrial.clientHash, freeTrial.reservationId, success);
        } catch (error) {
          console.error("free trial allowance completion failed", error);
        }
      }
    };
    let body;
    try { body = await c.req.json(); }
    catch {
      await finishTrial(false);
      return c.json({ ok: false, error: "request body must be JSON" }, 400);
    }
    const tool = TOOLS[path];
    const bad = validateArgs(tool.schema, body);
    if (bad) {
      await finishTrial(false);
      return c.json({ ok: false, error: bad }, 400);
    }
    let result;
    try {
      result = await tool.handler(body);
    } catch (error) {
      await finishTrial(false);
      c.set("handlerFailed", true);
      throw error;
    }
    // x402 settles successful (2xx) responses. A tool can fail cleanly by
    // returning {ok:false}; expose that as non-2xx so failed work is never charged.
    if (result && result.ok === false) {
      await finishTrial(false);
      c.set("handlerFailed", true);
      return c.json(result, 422);
    }
    await finishTrial(Boolean(freeTrial));
    if (freeTrial) {
      return c.json({
        ...result,
        free_trial: true,
        normal_price: tool.price,
        payment: `This free trial is used. Future calls cost ${tool.price} USDC on Base via x402.`,
      }, 200, { "X-Free-Trial": "true" });
    }
    return c.json(result);
  });
}

// MCP over streamable HTTP: the same ten tools, same per-route prices and wallet.
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

const pricing = { compute: COMPUTE_PRICE, network: NETWORK_PRICE, currency: "USDC", model: "per_call" };

app.get("/", (c) => c.json({
  name: "Penniless Data Utilities",
  description: "Ten deterministic data and lookup tools for AI agents, paid per successful call over x402 v2.",
  tools: Object.entries(TOOLS).map(([path, tool]) => ({
    name: tool.mcpName,
    path,
    method: "POST",
    description: tool.desc,
    price: tool.price,
    currency: "USDC",
  })),
  payment: {
    protocol: "x402 v2",
    scheme: "exact",
    network: NETWORK,
    asset: "USDC",
    assetAddress: USDC_BASE,
    facilitator: FACILITATOR,
  },
  links: {
    manifest: `${ORIGIN}/.well-known/x402`,
    agentManifest: `${ORIGIN}/.well-known/agent.json`,
    health: `${ORIGIN}/health`,
    mcp: `${ORIGIN}/mcp`,
  },
}));

app.get("/health", (c) => c.json({
  ok: true, x402Version: 2, mppRestEnabled: false, network: NETWORK, pricing, facilitator: FACILITATOR,
  endpoints: Object.keys(TOOLS), mcp: `${ORIGIN}/mcp`,
}));
app.get("/stats", async (c) => {
  const [{ counters, byEndpoint }, lifecycle] = await Promise.all([
    readCounters(c.env?.DB),
    readLifecycleSummary(c.env?.DB),
  ]);
  return c.json({
    ok: true,
    pricing,
    paid: true,
    endpoints: Object.keys(TOOLS),
    counters,
    by_endpoint: byEndpoint,
    payment_lifecycle: lifecycle,
    payment_lifecycle_semantics: "Aggregated durable lifecycle events. No IP, wallet address, payment payload, or request header is exposed or stored.",
    counter_semantics: {
      paid_attempts: "legacy counter: payment-required challenges plus verified settled successes; not a charge or customer count",
      payment_challenges: "derived unpaid payment-required challenges (legacy paid_attempts minus settled_success)",
      settled_success: "verified successful settlements; use this for paid sales",
    },
    note: counters.settled_success === 0
      ? "No verified paid sales are recorded yet. Counters persisted via D1."
      : "Verified paid sales are recorded in settled_success. Counters persisted via D1.",
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
  return c.json({ ok: true, parsesNow, inputBytes: input.length, problems, paidRepair: `POST /repair/json at ${TOOLS["/repair/json"].price} via x402 (USDC on Base)` });
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
  // Native MPP REST is intentionally disabled: x402 settles only after a
  // successful protected response, avoiding charge-on-failure behavior.
  mpp: { enabled: false },
  resources: [
    ...Object.entries(TOOLS).map(([path, t]) => ({
      url: `${ORIGIN}${path}`, method: "POST", description: t.desc,
      accepts: [t.accepts],
    })),
    {
      url: `${ORIGIN}/diagnose`, method: "POST",
      description: "Free preview: classifies what is wrong with a malformed JSON payload without returning the repaired output.",
      accepts: [],
    },
  ],
}));

app.get("/llms.txt", (c) => c.text(`${ORIGIN} - Penniless Data Utilities

Ten paid endpoints over x402 v2 on Base (eip155:8453), payTo ${PAY_TO}.
Pure-compute routes cost ${COMPUTE_PRICE} USDC; network-backed routes cost ${NETWORK_PRICE} USDC.
Each client receives one successful free trial on a pure-compute route per rolling 24 hours. Network-backed routes always require payment.

MCP (streamable HTTP): ${ORIGIN}/mcp - the same ten tools and per-tool prices.

Paid:
${Object.entries(TOOLS).map(([path, tool]) => `  POST ${path}  ${tool.price} USDC  ${tool.desc}`).join("\n")}

Free:
  POST /diagnose      {input}      -> {parsesNow, problems[]}   JSON problem classifier

Payment discovery:
  x402 v2:      ${ORIGIN}/.well-known/x402
`));

app.get("/openapi.json", (c) => {
  const paths = {};
  for (const [path, t] of Object.entries(TOOLS)) {
    paths[path] = {
      post: {
        summary: t.serviceName,
        description: t.desc,
        "x-payment-info": { price: { mode: "fixed", currency: "USD", amount: t.priceUsd }, protocols: [{ x402: {} }] },
        requestBody: { required: true, content: { "application/json": { schema: t.schema } } },
        responses: {
          "200": { description: "Result.", content: { "application/json": { schema: { type: "object" } } } },
          "400": { description: "Invalid request body." },
          "402": { description: "Payment required (x402 v2)." },
          "413": { description: "Input exceeds maxBytes." },
        },
      },
    };
  }
  paths["/diagnose"] = { post: { summary: "Free JSON problem classifier", description: "Free pre-check before paying for /repair/json.", requestBody: { required: true, content: { "application/json": { schema: { type: "object" } } } }, responses: { "200": { description: "ok" } } } };
  paths["/health"] = { get: { summary: "Liveness + config", responses: { "200": { description: "ok" } } } };
  paths["/mcp"] = { post: { summary: "MCP streamable HTTP transport", description: `Model Context Protocol endpoint exposing the same ten tools and their route prices over x402 v2. Compute ${COMPUTE_PRICE}; network-backed ${NETWORK_PRICE} USDC on Base.`, responses: { "200": { description: "JSON-RPC response." }, "402": { description: "Payment required (x402 v2)." } } } };
  return c.json({
    openapi: "3.1.0",
    info: {
      title: "Penniless Data Utilities",
      description: SEMANTIC,
      version: "3.1.0",
      "x-guidance": "Deterministic data and lookup tools for agents. Use /repair/json when JSON.parse rejects near-JSON from an LLM; /yaml/tojson to turn YAML config into JSON; /cron/nextrun to resolve a cron schedule; /diff to compare two texts; /text/extract to pull links/emails/headings from HTML; /domain/whois and /dns/lookup for domain registration and DNS records; /github/repo-stats for repository popularity; /email/validate to check syntax plus MX deliverability. Call the REST paths directly over x402 v2, or connect an MCP client to /mcp over x402 v2. Paid REST endpoints return an x402 HTTP 402 payment challenge; MCP tools/call uses x402 v2. /diagnose and /health are free.",
      "x-payment-server": {
        scheme: "exact",
        network: NETWORK,
        payTo: PAY_TO,
        pricing,
        asset: "USDC",
        assetAddress: USDC_BASE,
        mpp: { enabled: false },
      },
    },
    servers: [{ url: ORIGIN }],
    paths,
  });
});

export default app;
