// Single source of truth for the tool catalogue, input schemas, and handlers.
// Both the x402 HTTP routes (index.js) and the MCP transport (mcp.js) build
// themselves from this module so the two surfaces can never drift apart.

const ENV = (typeof process !== "undefined" && process.env) || {};

export const PAY_TO = ENV.X402_PAY_TO || "0x3D98800c64C345950E1eAaa076D88C12d1BF5F37";
export const NETWORK = ENV.X402_NETWORK || "eip155:8453";
export const FACILITATOR = ENV.X402_FACILITATOR || "https://facilitator.payai.network";
export const COMPUTE_PRICE = ENV.X402_COMPUTE_PRICE || "$0.005";
export const NETWORK_PRICE = ENV.X402_NETWORK_PRICE || "$0.02";
export const ORIGIN = ENV.X402_ORIGIN || ENV.PUBLIC_ORIGIN || "https://penniless-json-repair.sjaman.workers.dev";
export const MAX_INPUT = 200000;

// Native asset form used by the MCP payment wrapper and public rail metadata.
export const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

import { repairJson } from "./repair.js";
import { yamlToValue } from "./yaml.js";
import { cronNextRun } from "./cron.js";
import { diffLines } from "./diff.js";
import { extract } from "./extract.js";
import { whois, dnsLookup, githubRepoStats, cryptoPrice, validateEmail } from "./net.js";

const str = { type: "string" };
const obj = (properties, required) => ({ type: "object", properties, required, additionalProperties: false });

export const TOOLS = {
  "/repair/json": {
    price: COMPUTE_PRICE,
    mcpName: "repair_json",
    serviceName: "Penniless JSON Repair",
    tags: ["json", "llm", "repair", "agent-tools"],
    desc: "Repairs malformed LLM JSON: strips Markdown fences and prose wrappers, fixes trailing commas, converts Python literals (True/False/None) and single/unquoted keys, removes comments, recovers balanced JSON from truncated output. Body {input} -> {ok, repaired, applied}.",
    input: { input: "```json\n{foo: 'bar',}\n```" },
    schema: obj({ input: { ...str, description: "Malformed JSON text" } }, ["input"]),
    handler: (a) => repairJson(a.input),
    out: { ok: true, repaired: { foo: "bar" }, applied: ["fences", "unquoted-keys", "single-quotes"] },
  },
  "/yaml/tojson": {
    price: COMPUTE_PRICE,
    mcpName: "yaml_to_json",
    serviceName: "Penniless YAML to JSON",
    tags: ["yaml", "json", "convert", "config"],
    desc: "Converts YAML 1.2 core syntax (maps, sequences, nested structures, scalar values, comments, anchors/aliases) into JSON with bounded alias expansion. Body {input} -> {ok, value, warnings}.",
    input: { input: "name: web\nports:\n  - 80\n  - 443\ndb:\n  host: localhost\n  tls: true\n" },
    schema: obj({ input: { ...str, description: "YAML document text" } }, ["input"]),
    handler: (a) => yamlToValue(a.input),
    out: { ok: true, value: { name: "web", ports: [80, 443], db: { host: "localhost", tls: true } }, warnings: [] },
  },
  "/cron/nextrun": {
    price: COMPUTE_PRICE,
    mcpName: "cron_next_run",
    serviceName: "Penniless Cron Next Run",
    tags: ["cron", "schedule", "scheduler", "devops"],
    desc: "Computes the next UTC fire time for a 5-field cron expression (supports steps, ranges, lists, and month/weekday names). Body {expr, after?} -> {ok, next, epochMs}.",
    input: { expr: "*/15 9-17 * * MON-FRI", after: "2026-09-14T00:00:00Z" },
    schema: obj({
      expr: { ...str, description: "5-field cron expression" },
      after: { ...str, description: "ISO timestamp to search after (default now)" },
    }, ["expr"]),
    handler: (a) => cronNextRun(a.expr, a.after),
    out: { ok: true, next: "2026-09-14T09:00:00.000Z", epochMs: 1789866000000 },
  },
  "/diff": {
    price: COMPUTE_PRICE,
    mcpName: "text_diff",
    serviceName: "Penniless Text Diff",
    tags: ["diff", "unified-diff", "text", "compare"],
    desc: "Produces a unified diff plus added/removed counts between two texts (LCS line diff, configurable context lines). Body {old, new, context?} -> {ok, identical, added, removed, hunks, unified}.",
    input: { old: "a\nb\nc", new: "a\nB\nc" },
    schema: obj({
      old: { ...str, description: "Original text" },
      new: { ...str, description: "Changed text" },
      context: { type: "number", description: "Context lines per hunk (default 3)" },
    }, ["old", "new"]),
    handler: (a) => diffLines(a.old, a.new, a.context),
    out: { ok: true, identical: false, added: 1, removed: 1, unified: "@@ -1,3 +1,3 @@\n a\n-b\n+B\n c" },
  },
  "/text/extract": {
    price: COMPUTE_PRICE,
    mcpName: "text_extract",
    serviceName: "Penniless Text Extract",
    tags: ["html", "text", "extraction", "links", "emails"],
    desc: "Extracts clean text, title, headings, links, URLs, and emails from HTML or plain text. Body {input, numbers?, codeBlocks?} -> {ok, source, title, headings, links, urls, emails, text}.",
    input: { input: "<h1>Hi</h1><p>Visit https://x.dev and mail a@b.com</p>" },
    schema: obj({
      input: { ...str, description: "HTML or plain text" },
      numbers: { type: "boolean", description: "Extract numeric strings into numbers[]" },
      codeBlocks: { type: "boolean", description: "Extract Markdown fences and HTML pre/code blocks into codeBlocks[]" },
    }, ["input"]),
    handler: (a) => extract(a.input, a),
    out: { ok: true, source: "html", headings: [{ level: 1, text: "Hi" }], urls: ["https://x.dev"], emails: ["a@b.com"], text: "Hi Visit https://x.dev and mail a@b.com" },
  },
  "/domain/whois": {
    price: NETWORK_PRICE,
    mcpName: "domain_whois",
    serviceName: "Penniless WHOIS Lookup",
    tags: ["whois", "rdap", "domain", "osint", "registrar"],
    desc: "Structured WHOIS via RDAP for any domain: registrar, IANA id, statuses, expiry/registration dates, nameservers, DNSSEC. Body {domain} -> {ok, found, domain, registrar, status[], events{}, nameservers[], dnssec}.",
    input: { domain: "example.com" },
    schema: obj({ domain: { ...str, description: "Domain name, no scheme" } }, ["domain"]),
    handler: (a) => whois(a.domain),
    out: { ok: true, found: true, domain: "example.com", registrar: "Example Registrar, Inc.", status: ["client transfer prohibited"], events: { expiration: "2027-08-14T04:00:00Z", registration: "1995-08-14T04:00:00Z" }, nameservers: ["a.iana-servers.net", "b.iana-servers.net"], dnssec: { signed: true } },
  },
  "/dns/lookup": {
    price: NETWORK_PRICE,
    mcpName: "dns_lookup",
    serviceName: "Penniless DNS Lookup",
    tags: ["dns", "doh", "a", "aaaa", "mx", "txt", "ns", "cname", "caa"],
    desc: "JSON DNS-over-HTTPS lookup for A, AAAA, CNAME, MX, TXT, NS, SOA, PTR, SRV, CAA. Body {domain, type?} -> {ok, domain, type, status, answers[]}.",
    input: { domain: "example.com", type: "MX" },
    schema: obj({
      domain: { ...str, description: "Hostname to resolve" },
      type: { ...str, description: "Record type (default A)", enum: ["A", "AAAA", "CNAME", "MX", "TXT", "NS", "SOA", "PTR", "SRV", "CAA"], caseInsensitive: true },
    }, ["domain"]),
    handler: (a) => dnsLookup(a.domain, a.type),
    out: { ok: true, domain: "example.com", type: "MX", status: "NOERROR", answers: [{ name: "example.com", type: "MX", ttl: 180, data: "0 ." }] },
  },
  "/github/repo-stats": {
    price: NETWORK_PRICE,
    mcpName: "github_repo_stats",
    serviceName: "Penniless GitHub Repo Stats",
    tags: ["github", "repository", "stars", "popularity", "oss"],
    desc: "Popularity and metadata for any public GitHub repo: stars, forks, open issues, watchers, language, license, topics, last push. Body {repo} -> {ok, found, stars, forks, openIssues, language, license, pushedAt}.",
    input: { repo: "copperheadhq/copperhead" },
    schema: obj({ repo: { ...str, description: "owner/name" } }, ["repo"]),
    handler: (a) => githubRepoStats(a.repo),
    out: { ok: true, found: true, repo: "copperheadhq/copperhead", stars: 254, forks: 62, openIssues: 184, language: "TypeScript", license: "Apache-2.0", pushedAt: "2026-09-13T20:41:25Z" },
  },
  "/price/crypto": {
    price: NETWORK_PRICE,
    mcpName: "crypto_price",
    serviceName: "Penniless Crypto Price",
    tags: ["crypto", "price", "coingecko", "btc", "eth", "usdc", "sol", "x402"],
    desc: "Live USD prices for ETH, BTC, USDC, SOL from CoinGecko (30s cache). Body {symbols: ['eth','btc','usdc','sol']} -> {ok, source, prices: {eth:{usd}, btc:{usd}, ...}}.",
    input: { symbols: ["eth", "btc", "usdc", "sol"] },
    schema: obj({
      symbols: {
        type: "array",
        description: "Coin symbols, any of: eth, btc, usdc, sol",
        items: { type: "string", enum: ["eth", "btc", "usdc", "sol"] },
      },
    }, ["symbols"]),
    handler: (a) => cryptoPrice(a.symbols),
    out: { ok: true, source: "coingecko", fetchedAt: "2026-09-16T00:00:00.000Z", prices: { eth: { usd: 2403.99 }, btc: { usd: 75960.13 }, usdc: { usd: 0.9997 }, sol: { usd: 97.15 } } },
  },
  "/email/validate": {
    price: NETWORK_PRICE,
    mcpName: "email_validate",
    serviceName: "Penniless Email Validate",
    tags: ["email", "validation", "smtp", "mx", "deliverability"],
    desc: "Email domain validation: RFC-style unquoted syntax plus a live MX probe. It checks whether the domain advertises mail reception; it does not verify that a mailbox exists. Body {email} -> {ok, valid, formatValid, domainHasMx, mx[]}.",
    input: { email: "hello@example.com" },
    schema: obj({ email: { ...str, description: "Email address" } }, ["email"]),
    handler: (a) => validateEmail(a.email),
    out: { ok: true, email: "hello@example.com", valid: true, formatValid: true, domainHasMx: true, mx: [{ preference: 0, host: "" }], status: "NOERROR" },
  },
};

// Enrich each authoritative tool entry with the exact payment objects consumed
// by REST and MCP.  This makes it impossible for those surfaces to choose a
// price independently of the catalogue.
for (const tool of Object.values(TOOLS)) {
  tool.priceUsd = Number.parseFloat(tool.price.slice(1)).toFixed(6);
  tool.priceAtomic = String(Math.round(Number(tool.price.slice(1)) * 1e6));
  tool.accepts = { scheme: "exact", price: tool.price, network: NETWORK, payTo: PAY_TO };
  tool.mcpAccepts = {
    scheme: "exact",
    network: NETWORK,
    amount: tool.priceAtomic,
    asset: USDC_BASE,
    payTo: PAY_TO,
    maxTimeoutSeconds: 300,
    extra: { name: "USD Coin", version: "2" },
  };
}

export const COMPUTE_TOOL_PATHS = Object.entries(TOOLS)
  .filter(([, tool]) => tool.price === COMPUTE_PRICE)
  .map(([path]) => path);

export const SEMANTIC = [
  "Deterministic, dependency-free data utilities served over x402 micropayments (USDC on Base). None of these call another AI model.",
  "Keyword: JSON repair", "Keyword: malformed JSON", "Keyword: broken JSON from LLM",
  "Keyword: fix JSON output", "Keyword: JSON sanitizer", "Keyword: truncated JSON recovery",
  "Keyword: YAML to JSON", "Keyword: convert YAML", "Keyword: parse YAML config",
  "Keyword: cron next run", "Keyword: cron parser", "Keyword: when does cron run next",
  "Keyword: unified diff", "Keyword: line diff", "Keyword: text diff",
  "Keyword: HTML to text", "Keyword: extract links", "Keyword: extract emails", "Keyword: scrape text",
  "Keyword: whois lookup", "Keyword: domain registration", "Keyword: registrar", "Keyword: domain expiry date", "Keyword: RDAP",
  "Keyword: dns lookup", "Keyword: MX records", "Keyword: TXT records", "Keyword: A record", "Keyword: DNS over HTTPS",
  "Keyword: github repo stats", "Keyword: github stars", "Keyword: repository popularity", "Keyword: OSS project metadata",
  "Keyword: email validation", "Keyword: verify email address", "Keyword: check MX deliverability", "Keyword: email syntax",
  "Use case: repair a JSON code block wrapped in Markdown fences",
  "Use case: turn a docker-compose or CI YAML file into JSON",
  "Use case: compute the next UTC fire time of a cron expression",
  "Use case: produce a unified diff between two versions of a file",
  "Use case: strip HTML tags and pull out links, emails, and headings",
  "Use case: look up a domain's registrar, status and expiry before purchase",
  "Use case: check when a domain registration lapses",
  "Use case: resolve A, AAAA, MX, TXT or NS records for a hostname",
  "Use case: find a domain's mail servers and SPF TXT record",
  "Use case: compare GitHub repository stars, forks and activity for market research",
  "Use case: check whether an email address is well-formed and its domain accepts mail",
].join("\n");

export function argError(message) {
  return { ok: false, error: message };
}

// Validates against the tool's JSON schema so the HTTP and MCP surfaces
// enforce exactly the same contract from one definition.
export function validateArgs(schema, args) {
  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    return "arguments must be a JSON object";
  }
  for (const key of schema.required ?? []) {
    if (args[key] === undefined) return `field '${key}' is required`;
  }
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(args)) {
      if (!Object.hasOwn(schema.properties, key)) return `field '${key}' is not allowed`;
    }
  }
  for (const [key, spec] of Object.entries(schema.properties)) {
    const value = args[key];
    if (value === undefined || value === null) continue;
    if (spec.type === "string") {
      if (typeof value !== "string") return `field '${key}' must be a string`;
      if (value.length > MAX_INPUT) return `field '${key}' exceeds maxBytes`;
    } else if (spec.type === "number") {
      if (typeof value !== "number" || !Number.isFinite(value)) return `field '${key}' must be a number`;
    } else if (spec.type === "boolean") {
      if (typeof value !== "boolean") return `field '${key}' must be a boolean`;
    } else if (spec.type === "array") {
      if (!Array.isArray(value)) return `field '${key}' must be an array`;
      const item = spec.items;
      if (item) {
        for (const element of value) {
          if (item.type === "string" && typeof element !== "string") return `field '${key}' items must be strings`;
          if (item.type === "number" && (typeof element !== "number" || !Number.isFinite(element))) return `field '${key}' items must be numbers`;
          if (item.type === "boolean" && typeof element !== "boolean") return `field '${key}' items must be booleans`;
          if (item.enum && !item.enum.includes(element)) return `field '${key}' items must be one of ${item.enum.join(", ")}`;
        }
      }
    }
    if (spec.enum) {
      const ok = spec.caseInsensitive
        ? spec.enum.some((e) => String(e).toLowerCase() === String(value).toLowerCase())
        : spec.enum.includes(value);
      if (!ok) return `field '${key}' must be one of ${spec.enum.join(", ")}`;
    }
  }
  return null;
}
