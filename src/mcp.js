import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { createPaymentWrapper } from "@x402/mcp";
import { TOOLS, MCP_ACCEPTS, ORIGIN, PRICE, validateArgs } from "./shared.js";

const ZOD_BY_TYPE = { string: () => z.string(), number: () => z.number(), boolean: () => z.boolean() };

// Zod cannot express a case-insensitive enum, and these enum values (DNS record
// types) are case-folded by the handlers and by validateArgs. Upper-casing first
// keeps the advertised MCP schema accurate without diverging from REST behavior.
function zodField(spec) {
  const described = (inner) => (spec.description ? inner.describe(spec.description) : inner);
  if (spec.enum) {
    return z.preprocess(
      (v) => (typeof v === "string" ? v.toUpperCase() : v),
      described(z.enum(spec.enum)),
    );
  }
  return described((ZOD_BY_TYPE[spec.type] ?? ZOD_BY_TYPE.string)());
}

function buildZodSchema(schema) {
  const required = new Set(schema.required ?? []);
  const shape = {};
  for (const [key, spec] of Object.entries(schema.properties)) {
    const field = zodField(spec);
    shape[key] = required.has(key) ? field : field.optional();
  }
  return z.object(shape);
}

// MCP over streamable HTTP, stateless: Cloudflare Workers must not hold session
// state across requests, and the spec allows a fresh transport per request.
// One server instance can only ever connect to one transport, so a fresh
// McpServer + transport is built per request. This is also what makes the
// endpoint stateless, which Cloudflare Workers require.
export function createMcpHandler(resourceServer) {
  return async (request) => {
    const server = buildServer(resourceServer);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonRpcNotificationHandling: true,
    });
    await server.connect(transport);
    return transport.handleRequest(request);
  };
}

function buildServer(resourceServer) {
  const server = new McpServer(
    { name: "penniless-data-utilities", version: "3.1.0" },
    {
      description:
        "Deterministic data utilities for agents, paid per call in USDC on Base over x402: JSON repair, YAML to JSON, cron next-run, text diff, HTML/text extraction, WHOIS, DNS, GitHub repo stats, email validation.",
      instructions:
        `Every tool costs ${PRICE} USDC on Base via x402 v2. Call tools/list first; an unpaid tools/call returns a payment-required error whose data carries the payment requirements. Attach the signed x402 payment in the request _meta and retry the same call.`,
      website: ORIGIN,
    },
  );

  for (const [path, t] of Object.entries(TOOLS)) {
    const paid = createPaymentWrapper(resourceServer, {
      accepts: [MCP_ACCEPTS],
      resource: {
        url: `mcp://tool/${t.mcpName}`,
        description: t.desc,
        mimeType: "application/json",
        serviceName: t.serviceName,
        tags: t.tags,
      },
    });

    server.registerTool(
      t.mcpName,
      {
        title: t.serviceName,
        description: `${t.desc} Costs ${PRICE} USDC on Base per call.`,
        inputSchema: buildZodSchema(t.schema),
        outputSchema: z.object({ ok: z.boolean() }).passthrough(),
      },
      paid(async (args) => {
        const bad = validateArgs(t.schema, args);
        if (bad) return { content: [{ type: "text", text: bad }], isError: true };
        const result = await t.handler(args);
        const failed = result && result.ok === false;
        return {
          structuredContent: result,
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          isError: !!failed,
        };
      }),
    );
  }

  return server;
}
