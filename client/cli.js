#!/usr/bin/env node

const DEFAULT_BASE_URL = "https://penniless-json-repair.sjaman.workers.dev";

const TOOL_METHODS = new Map([
  ["repair-json", "repairJson"],
  ["repair_json", "repairJson"],
  ["yaml-to-json", "yamlToJson"],
  ["yaml_to_json", "yamlToJson"],
  ["cron-next-run", "cronNextRun"],
  ["cron_next_run", "cronNextRun"],
  ["text-diff", "textDiff"],
  ["text_diff", "textDiff"],
  ["text-extract", "textExtract"],
  ["text_extract", "textExtract"],
  ["domain-whois", "domainWhois"],
  ["domain_whois", "domainWhois"],
  ["dns-lookup", "dnsLookup"],
  ["dns_lookup", "dnsLookup"],
  ["github-repo-stats", "githubRepoStats"],
  ["github_repo_stats", "githubRepoStats"],
  ["crypto-price", "cryptoPrice"],
  ["crypto_price", "cryptoPrice"],
  ["email-validate", "emailValidate"],
  ["email_validate", "emailValidate"],
]);

const CANONICAL_TOOLS = [
  "repair-json",
  "yaml-to-json",
  "cron-next-run",
  "text-diff",
  "text-extract",
  "domain-whois",
  "dns-lookup",
  "github-repo-stats",
  "crypto-price",
  "email-validate",
];

function usage() {
  return `Usage: pdu <tool> [--json '<args>'] [--base-url URL]
       pdu mcp-config
       pdu verify [--base-url URL]

Paid tools:
  ${CANONICAL_TOOLS.join("\n  ")}

Options:
  --json JSON       Tool arguments (default: {})
  --base-url URL    Service origin (default: ${DEFAULT_BASE_URL})
  -h, --help        Show this help

Set PDU_PRIVATE_KEY in the process environment to pay for a tool call.`;
}

function mcpConfig() {
  return JSON.stringify({
    mcpServers: {
      "penniless-data-utilities": {
        type: "http",
        url: `${DEFAULT_BASE_URL}/mcp`,
      },
    },
  }, null, 2);
}

function parseOptions(argv) {
  const options = { json: "{}", baseUrl: DEFAULT_BASE_URL };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json" || arg === "--base-url") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`${arg} requires a value`);
      }
      if (arg === "--json") options.json = value;
      else options.baseUrl = value;
      i += 1;
      continue;
    }
    if (arg === "-h" || arg === "--help") {
      options.help = true;
      continue;
    }
    throw new Error(`unknown option: ${arg}`);
  }

  return options;
}

function parseJson(value) {
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("--json must be valid JSON");
  }
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error("--json must contain a JSON object");
  }
  return parsed;
}

function toolArguments(method, args) {
  switch (method) {
    case "repairJson":
    case "yamlToJson":
      return [args.input];
    case "cronNextRun":
      return [args.expr, args.after];
    case "textDiff":
      return [args.old, args.new ?? args.newText, args.context];
    case "textExtract": {
      const { input, ...options } = args;
      return [input, options];
    }
    case "domainWhois":
      return [args.domain];
    case "dnsLookup":
      return [args.domain, args.type];
    case "githubRepoStats":
      return [args.repo];
    case "cryptoPrice":
      return [args.symbols];
    case "emailValidate":
      return [args.email];
    default:
      throw new Error("unsupported tool");
  }
}

async function printResult(result) {
  if (result instanceof Response) {
    const contentType = result.headers.get("content-type") || "";
    const value = contentType.includes("application/json")
      ? await result.json()
      : await result.text();
    if (!result.ok) {
      const detail = typeof value === "string" ? value : JSON.stringify(value);
      throw new Error(`HTTP ${result.status}${detail ? `: ${detail}` : ""}`);
    }
    console.log(typeof value === "string" ? value : JSON.stringify(value, null, 2));
    return;
  }
  console.log(typeof result === "string" ? result : JSON.stringify(result, null, 2));
}

function safeMessage(error) {
  let message = error instanceof Error ? error.message : String(error);
  message = message.replace(/\b0x[0-9a-fA-F]{64}\b/g, "[REDACTED]");
  return message.replace(/[\r\n]+/g, " ").trim() || "unknown error";
}

async function main(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv;
  if (!command || command === "-h" || command === "--help" || command === "help") {
    console.log(usage());
    return;
  }

  if (command === "mcp-config") {
    if (rest.length) throw new Error("mcp-config takes no options");
    console.log(mcpConfig());
    return;
  }

  const options = parseOptions(rest);
  if (options.help) {
    console.log(usage());
    return;
  }

  if (command === "verify") {
    if (options.json !== "{}") throw new Error("verify does not accept --json");
    const { runLiveVerification } = await import("./scripts/verify-live.mjs");
    await runLiveVerification({ baseUrl: options.baseUrl });
    return;
  }

  const method = TOOL_METHODS.get(command);
  if (!method) throw new Error(`unknown tool: ${command}`);

  const args = parseJson(options.json);
  const { accountFromEnv, createPennilessClient } = await import("./index.js");
  const account = await accountFromEnv();
  const client = createPennilessClient({ baseUrl: options.baseUrl, account });
  await printResult(await client.tools[method](...toolArguments(method, args)));
}

main().catch((error) => {
  console.error(safeMessage(error));
  process.exitCode = 1;
});
