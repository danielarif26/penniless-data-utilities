import { Hono } from "hono";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";
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

const routes = {};
for (const [path, t] of Object.entries(TOOLS)) {
  routes[`POST ${path}`] = {
    accepts: ACCEPTS,
    description: t.desc,
    mimeType: "application/json",
    serviceName: t.serviceName,
    tags: t.tags,
    extensions: declareDiscoveryExtension({ bodyType: "json", input: t.input, inputSchema: { type: "object" }, output: { example: t.out, schema: { type: "object" } } }),
  };
}

const app = new Hono();

for (const path of Object.keys(TOOLS)) {
  app.use(path, async (c, next) => {
    if (!(await ensureResourceServerInitialized())) {
      return c.json({ ok: false, error: "x402 facilitator unavailable" }, 503);
    }
    return next();
  });
}

app.use(paymentMiddleware(routes, resourceServer, undefined, undefined, false));

for (const path of Object.keys(TOOLS)) {
  app.post(path, async (c) => {
    let body;
    try { body = await c.req.json(); }
    catch { return c.json({ ok: false, error: "request body must be JSON" }, 400); }
    const tool = TOOLS[path];
    const bad = validateArgs(tool.schema, body);
    if (bad) return c.json({ ok: false, error: bad }, 400);
    return c.json(await tool.handler(body));
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
  ok: true, x402Version: 2, network: NETWORK, price: PRICE, facilitator: FACILITATOR,
  endpoints: Object.keys(TOOLS), mcp: `${ORIGIN}/mcp`,
}));
app.get("/stats", (c) => c.json({ ok: true, price: PRICE, paid: true, endpoints: Object.keys(TOOLS), note: "per-endpoint counters not yet persisted (D1 pending)" }));

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

app.get("/.well-known/x402", (c) => c.json({
  version: 1,
  x402Version: 2,
  name: "Penniless Data Utilities",
  description: SEMANTIC,
  openapi: `${ORIGIN}/openapi.json`,
  llms: `${ORIGIN}/llms.txt`,
  mcp: `${ORIGIN}/mcp`,
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

All paid endpoints: x402 v2, ${PRICE} USDC on Base (eip155:8453), payTo ${PAY_TO}.

MCP (streamable HTTP): ${ORIGIN}/mcp - the same nine tools, priced per tools/call.

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
`));

app.get("/openapi.json", (c) => {
  const paths = {};
  for (const [path, t] of Object.entries(TOOLS)) {
    paths[path] = {
      post: {
        summary: t.serviceName,
        description: t.desc,
        "x-payment-info": { price: { mode: "fixed", currency: "USD", amount: PRICE_USD }, protocols: [{ x402: {} }] },
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
  paths["/mcp"] = { post: { summary: "MCP streamable HTTP transport", description: `Model Context Protocol endpoint exposing the same tools. Per-call price ${PRICE} USDC on Base.`, responses: { "200": { description: "JSON-RPC response." }, "402": { description: "Payment required." } } } };
  return c.json({
    openapi: "3.1.0",
    info: {
      title: "Penniless Data Utilities",
      description: SEMANTIC,
      version: "3.1.0",
      "x-guidance": "Deterministic data and lookup tools for agents. Use /repair/json when JSON.parse rejects near-JSON from an LLM; /yaml/tojson to turn YAML config into JSON; /cron/nextrun to resolve a cron schedule; /diff to compare two texts; /text/extract to pull links/emails/headings from HTML; /domain/whois and /dns/lookup for domain registration and DNS records; /github/repo-stats for repository popularity; /email/validate to check syntax plus MX deliverability. Either call the REST paths directly or connect an MCP client to /mcp. Paid endpoints return HTTP 402 with an x402 payment requirement; call via an x402 client (e.g. agentcash fetch). /diagnose and /health are free.",
    },
    servers: [{ url: ORIGIN }],
    paths,
  });
});

export default app;
