# Penniless Data Utilities

Ten deterministic data and lookup tools for AI agents, paid per call in USDC.
REST and MCP use [x402](https://x402.org) v2. Native MPP REST is intentionally disabled so a failed tool call cannot be charged. No accounts, no API keys, no rate-limit tiers. Every tool is pure computation or a keyless public lookup — none of them call another AI model, so results are reproducible.

- Live endpoint (MCP): https://penniless-json-repair.sjaman.workers.dev/mcp
- Live endpoint (REST): https://penniless-json-repair.sjaman.workers.dev
- Discovery: `/health`, `/openapi.json`, `/llms.txt`, `/.well-known/x402`

## Pricing

Pure-compute routes cost `$0.005` USDC per call. Network-backed routes cost `$0.02` USDC per call. REST and MCP use x402 v2 (`eip155:8453`, scheme `exact`).
Each client can make **one successful free trial** on any pure-compute route in a rolling 24-hour window. The response identifies the trial and its normal price. Network-backed routes always require payment.
Clients can opt out of the trial (for example, monitoring probes) with `X-Penniless-Free-Trial: off`.

Base x402 settlements are verified by the free-tier [PayAI](https://facilitator.payai.network) facilitator. Native MPP REST is intentionally disabled. Recipient (`payTo`): `0x3D98800c64C345950E1eAaa076D88C12d1BF5F37`.

## Connect over MCP

Any MCP client that speaks streamable HTTP can connect directly:

```json
{
  "mcpServers": {
    "penniless-data-utilities": {
      "type": "http",
      "url": "https://penniless-json-repair.sjaman.workers.dev/mcp"
    }
  }
}
```

The transport is stateless — no session id is issued or required, and every request is independent. `initialize` and `tools/list` are free. An unpaid `tools/call` returns an x402 payment-required payload in `result.content[0].text` (and `result.structuredContent`); attach the signed payment as `params._meta["x402/payment"]` and repeat the call.

If you use an x402-aware MCP client, `@x402/mcp` handles that exchange for you.

## Tools

| MCP name           | REST path                 | Price    | Arguments                          | Returns |
| ------------------ | ------------------------- | -------- | ---------------------------------- | ------- |
| `repair_json`      | `POST /repair/json`       | `$0.005` | `{input}`                          | repaired JSON + which fixes applied |
| `yaml_to_json`     | `POST /yaml/tojson`       | `$0.005` | `{input}`                          | parsed value + warnings |
| `cron_next_run`    | `POST /cron/nextrun`      | `$0.005` | `{expr, after?}`                   | next UTC fire time |
| `text_diff`        | `POST /diff`              | `$0.005` | `{old, new, context?}`             | unified diff + counts |
| `text_extract`     | `POST /text/extract`      | `$0.005` | `{input, numbers?, codeBlocks?}`   | text, title, headings, links, URLs, emails |
| `domain_whois`     | `POST /domain/whois`      | `$0.02`  | `{domain}`                         | registrar, statuses, expiry, nameservers, DNSSEC |
| `dns_lookup`       | `POST /dns/lookup`        | `$0.02`  | `{domain, type?}`                  | DoH answers for A/AAAA/CNAME/MX/TXT/NS/SOA/PTR/SRV/CAA |
| `github_repo_stats`| `POST /github/repo-stats` | `$0.02`  | `{repo}`                           | stars, forks, open issues, language, license |
| `crypto_price`     | `POST /price/crypto`      | `$0.02`  | `{symbols}`                        | live CoinGecko USD prices for ETH/BTC/USDC/SOL |
| `email_validate`   | `POST /email/validate`    | `$0.02`  | `{email}`                          | syntax + live MX deliverability |

`POST /diagnose` is free: it classifies what is wrong with a malformed JSON payload without returning the repaired output, so a caller can check whether paying is worthwhile before paying.

### Example (REST + x402 client)

Any x402 v2 client works. With the reference TypeScript client and a viem account:

```js
import { x402Client } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import { privateKeyToAccount } from "viem/accounts";

const client = new x402Client();
registerExactEvmScheme(client, { signer: privateKeyToAccount(key), networks: ["eip155:8453"] });
const pay = wrapFetchWithPayment(fetch, client);

const res = await pay("https://penniless-json-repair.sjaman.workers.dev/repair/json", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ input: "{foo: 'bar',}" }),
});
// -> { ok: true, repaired: { foo: "bar" }, applied: ["unquoted-keys","single-quotes","trailing-commas"] }
```

`wrapFetchWithPayment` handles the 402 round-trip: it receives the requirement, signs the USDC authorization, retries, and only returns a `200` once the facilitator has settled.

## Development

```bash
npm install
npm test        # runs fully offline (facilitator + upstream are injected)
npx wrangler dev
npx wrangler deploy
```

Environment (set in `wrangler.toml`): `X402_NETWORK`, `X402_FACILITATOR`, `X402_PAY_TO`, and `X402_ORIGIN`. Route prices are defined in the authoritative tool manifest. Native MPP REST is disabled, and wallet private keys are never deployed to the Worker.

Set `FREE_TRIAL_SALT` as a Worker secret before deploying. The Worker uses it only to one-way-hash a client IP plus coarse user-agent class for the free-trial allowance; it never persists the IP or raw user agent.

## Maintainer

GitHub: [@danielarif26](https://github.com/danielarif26)