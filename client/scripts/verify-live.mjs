#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import { parsePaymentRequirement } from "../index.js";

const DEFAULT_BASE_URL = "https://penniless-json-repair.sjaman.workers.dev";
const EXPECTED_PAY_TO = "0x3D98800c64C345950E1eAaa076D88C12d1BF5F37";
const REQUEST_TIMEOUT_MS = 15_000;

const PAID_ENDPOINTS = [
  ["/repair/json", { input: "{foo: 1,}" }, "5000"],
  ["/yaml/tojson", { input: "name: verifier" }, "5000"],
  ["/cron/nextrun", { expr: "0 * * * *", after: "2026-01-01T00:00:00Z" }, "5000"],
  ["/diff", { old: "before", new: "after" }, "5000"],
  ["/text/extract", { input: "<p>verification</p>" }, "5000"],
  ["/domain/whois", { domain: "example.com" }, "20000"],
  ["/dns/lookup", { domain: "example.com", type: "A" }, "20000"],
  ["/github/repo-stats", { repo: "danielarif26/penniless-data-utilities" }, "20000"],
  ["/price/crypto", { symbols: ["eth", "btc"] }, "20000"],
  ["/email/validate", { email: "hello@example.com" }, "20000"],
];

const EXPECTED_TOOLS = [
  "cron_next_run",
  "crypto_price",
  "dns_lookup",
  "domain_whois",
  "email_validate",
  "github_repo_stats",
  "repair_json",
  "text_diff",
  "text_extract",
  "yaml_to_json",
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function jsonHeaders() {
  // Deliberately contains neither X-PAYMENT nor PAYMENT-SIGNATURE. This script
  // observes payment requirements only and can never authorize settlement.
  return {
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
    "mcp-protocol-version": "2025-06-18",
    // Keep probes read-only from the allowance perspective. Agents omit this
    // header to receive their one free compute trial.
    "x-penniless-free-trial": "off",
  };
}

async function request(fetchImpl, url, init = {}) {
  const response = await fetchImpl(url, {
    ...init,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  return response;
}

function extractPaymentPayload(response) {
  // x402 v2 can return the requirement in either the response body
  // or the payment-required header. Check both.
  const header = response.headers.get("payment-required");
  if (header) {
    try {
      const decoded = atob(header);
      return JSON.parse(decoded);
    } catch {
      // Fall through to body parsing if header decode fails
    }
  }
  return null;
}

async function readJson(response, label) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} returned non-JSON content`);
  }
}

async function readMcpJson(response, label) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    const messages = [];
    for (const event of text.split(/\r?\n\r?\n/)) {
      const data = event.split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (!data) continue;
      try {
        messages.push(JSON.parse(data));
      } catch {
        // Ignore keepalives or other non-JSON SSE events.
      }
    }
    if (messages.length === 0) throw new Error(`${label} returned neither JSON nor JSON SSE data`);
    return messages.at(-1);
  }
}

function amountFrom(requirement) {
  return String(
    requirement.maxAmountNormalized
      ?? requirement.maxAmountRequired
      ?? requirement.amount
      ?? "",
  );
}

function validateRequirement(payload, label, expectedAmount) {
  const requirement = parsePaymentRequirement(payload);
  const amount = amountFrom(requirement);
  assert(amount === expectedAmount, `${label} advertised amount ${amount || "<missing>"}, expected ${expectedAmount}`);
  assert(
    requirement.payTo.toLowerCase() === EXPECTED_PAY_TO.toLowerCase(),
    `${label} advertised payTo ${requirement.payTo}, expected ${EXPECTED_PAY_TO}`,
  );
  return requirement;
}

function fixedWidthTable(rows) {
  const widths = [28, 8, 13, 42];
  const format = (values) => values.map((value, index) => String(value).padEnd(widths[index])).join("  ");
  return [
    format(["ENDPOINT", "STATUS", "PARSED-AMOUNT", "PAYTO"]),
    format(widths.map((width) => "-".repeat(width))),
    ...rows.map((row) => format([row.endpoint, row.status, row.amount, row.payTo])),
  ].join("\n");
}

function normalizeBaseUrl(baseUrl) {
  const url = new URL(baseUrl);
  url.pathname = url.pathname.replace(/\/$/, "");
  url.search = "";
  url.hash = "";
  return url.href.replace(/\/$/, "");
}

export async function runLiveVerification({
  baseUrl = DEFAULT_BASE_URL,
  fetch: fetchImpl = globalThis.fetch,
} = {}) {
  assert(typeof fetchImpl === "function", "global fetch is unavailable");
  const origin = normalizeBaseUrl(baseUrl);
  const rows = [];
  const failures = [];

  async function check(endpoint, run) {
    const row = { endpoint, status: "ERROR", amount: "-", payTo: "-" };
    try {
      await run(row);
    } catch (error) {
      failures.push(`${endpoint}: ${errorMessage(error)}`);
    }
    rows.push(row);
  }

  for (const [path, body, expectedAmount] of PAID_ENDPOINTS) {
    await check(path, async (row) => {
      const response = await request(fetchImpl, `${origin}${path}`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify(body),
      });
      row.status = response.status;
      assert(response.status === 402, `${path} returned HTTP ${response.status}, expected 402`);
      // x402 v2 requirement may be in header (preferred) or body
      let payload = extractPaymentPayload(response);
      if (!payload) {
        payload = await readJson(response, path);
      }
      const requirement = validateRequirement(payload, path, expectedAmount);
      row.amount = amountFrom(requirement);
      row.payTo = requirement.payTo;
    });
  }

  await check("/health", async (row) => {
    const response = await request(fetchImpl, `${origin}/health`);
    row.status = response.status;
    assert(response.status === 200, `/health returned HTTP ${response.status}, expected 200`);
    const body = await readJson(response, "/health");
    assert(body?.ok === true, "/health did not report ok=true");
  });

  await check("/diagnose", async (row) => {
    const response = await request(fetchImpl, `${origin}/diagnose`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ input: "{foo: 1,}" }),
    });
    row.status = response.status;
    assert(response.status === 200, `/diagnose returned HTTP ${response.status}, expected 200`);
    const body = await readJson(response, "/diagnose");
    assert(body?.ok === true, "/diagnose did not report ok=true");
  });

  await check("/mcp tools/list", async (row) => {
    const response = await request(fetchImpl, `${origin}/mcp`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ jsonrpc: "2.0", id: "verify-list", method: "tools/list", params: {} }),
    });
    row.status = response.status;
    assert(response.status === 200, `MCP tools/list returned HTTP ${response.status}, expected 200`);
    const body = await readMcpJson(response, "MCP tools/list");
    assert(!body?.error, `MCP tools/list returned JSON-RPC error ${body?.error?.code ?? "unknown"}`);
    const names = body?.result?.tools?.map((tool) => tool.name).sort();
    assert(Array.isArray(names), "MCP tools/list response is missing result.tools");
    assert(
      JSON.stringify(names) === JSON.stringify(EXPECTED_TOOLS),
      `MCP tools/list returned [${names.join(", ")}], expected exactly the ten published tools`,
    );
    const crypto = body.result.tools.find((tool) => tool.name === "crypto_price");
    assert(crypto?.inputSchema?.properties?.symbols?.type === "array", "crypto_price.symbols is not an array schema");
  });

  await check("/mcp tools/call", async (row) => {
    const response = await request(fetchImpl, `${origin}/mcp`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "verify-call",
        method: "tools/call",
        params: { name: "repair_json", arguments: { input: "{foo: 1,}" } },
      }),
    });
    row.status = response.status;
    assert(response.status === 200, `unpaid MCP tools/call returned HTTP ${response.status}, expected 200`);
    const body = await readMcpJson(response, "MCP tools/call");
    const result = body?.result;
    assert(result?.isError === true, "unpaid MCP tools/call did not return isError=true");
    assert(
      result?.structuredContent && typeof result.structuredContent === "object",
      "unpaid MCP tools/call is missing result.structuredContent",
    );
    const text = result?.content?.[0]?.text;
    assert(typeof text === "string", "unpaid MCP tools/call is missing result.content[0].text");
    let textPayload;
    try {
      textPayload = JSON.parse(text);
    } catch {
      throw new Error("unpaid MCP tools/call result.content[0].text is not JSON");
    }
    const structuredRequirement = validateRequirement(result.structuredContent, "MCP structuredContent", "5000");
    validateRequirement(textPayload, "MCP content[0].text", "5000");
    row.amount = amountFrom(structuredRequirement);
    row.payTo = structuredRequirement.payTo;
  });

  for (const path of ["/.well-known/x402", "/openapi.json"]) {
    await check(path, async (row) => {
      const response = await request(fetchImpl, `${origin}${path}`);
      row.status = response.status;
      assert(response.status === 200, `${path} returned HTTP ${response.status}, expected 200`);
      await readJson(response, path);
    });
  }

  await check("/", async (row) => {
    const response = await request(fetchImpl, `${origin}/`);
    row.status = response.status;
    assert(response.status === 200, `/ returned HTTP ${response.status}, expected 200`);
    const body = await readJson(response, "/");
    assert(Array.isArray(body?.tools) && body.tools.length === 10, "/ did not advertise ten tools");
  });

  console.log(fixedWidthTable(rows));
  if (failures.length > 0) {
    throw new Error(`${failures.length} live verification check(s) failed: ${failures.join("; ")}`);
  }
  return rows;
}

function commandLineBaseUrl(args) {
  if (args.length === 0) return DEFAULT_BASE_URL;
  if (args.length === 2 && args[0] === "--base-url") return args[1];
  throw new Error("usage: verify-live.mjs [--base-url URL]");
}

const isDirectRun = process.argv[1]
  && pathToFileURL(process.argv[1]).href === import.meta.url;

if (isDirectRun) {
  try {
    await runLiveVerification({ baseUrl: commandLineBaseUrl(process.argv.slice(2)) });
  } catch (error) {
    console.error(`verify-live: ${errorMessage(error)}`);
    process.exitCode = 1;
  }
}
