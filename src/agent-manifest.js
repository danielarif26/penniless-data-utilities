import { TOOLS, ORIGIN, PAY_TO, PRICE_USD, USDC_BASE } from "./shared.js";

function parametersFromSchema(schema = {}) {
  const required = new Set(schema.required ?? []);
  return Object.fromEntries(Object.entries(schema.properties ?? {}).map(([name, spec]) => [name, {
    type: spec.type ?? "string",
    required: required.has(name),
    ...(spec.description ? { description: spec.description } : {}),
    ...(Array.isArray(spec.enum) ? { enum: spec.enum } : {}),
  }]));
}

export function buildAgentManifest() {
  return {
    version: "1.4",
    origin: new URL(ORIGIN).host,
    display_name: "Penniless Data Utilities",
    description: "Nine deterministic data and lookup utilities for AI agents, paid per call with x402 v2 USDC on Base; no API key or signup required.",
    payout_address: PAY_TO,
    payments: {
      x402: {
        networks: [{
          network: "base",
          asset: "USDC",
          contract: USDC_BASE,
        }],
      },
    },
    intents: Object.entries(TOOLS).map(([endpoint, tool]) => ({
      name: tool.mcpName,
      description: tool.desc,
      endpoint,
      method: "POST",
      parameters: parametersFromSchema(tool.schema),
      price: {
        amount: Number(PRICE_USD),
        currency: "USDC",
      },
      payments: {
        x402: {
          networks: [{ network: "base", asset: "USDC", contract: USDC_BASE }],
        },
      },
    })),
  };
}
