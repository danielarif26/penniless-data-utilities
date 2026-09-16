# Penniless Data Utilities

Nine deterministic data and lookup tools for AI agents, paid per call in USDC.
REST advertises native MPP and [x402](https://x402.org) v1 and v2 at once; MCP uses x402 v2. No accounts, no API keys, no rate-limit
tiers. Every tool is pure computation or a keyless public lookup — none of them
call another AI model, so results are reproducible.

- Web tool (free, no wallet): https://penniless-json-repair.sjaman.workers.dev/
- Live endpoint (MCP): https://penniless-json-repair.sjaman.workers.dev/mcp
- Live endpoint (REST): https://penniless-json-repair.sjaman.workers.dev
- Discovery: `/health`, `/openapi.json`, `/llms.txt`, `/.well-known/x402`

## Web tool

`GET /` serves the JSON repair passes as a page. It compiles them into the
browser and runs them there, so nothing is uploaded, no request reaches the
Worker after load, and it works offline. Every pass that fires is named, which
is the part a generic formatter does not tell you.

The paid API below is the same nine passes for agents and scripts.

## Pricing

`$0.001` USDC per call. REST advertises native MPP plus x402 v2 (`eip155:8453`, scheme `exact`) and x402 v1 (`base`); MCP uses x402 v2.

A paid REST endpoint answers an unpaid call with every rail at once, so a client
pays with whichever one it already speaks:

| Rail | Requirements arrive in | Payment goes back in | Receipt |
| ---- | ---------------------- | -------------------- | ------- |
| x402 v2 / MPP | `PAYMENT-REQUIRED` header | `PAYMENT-SIGNATURE` | `PAYMENT-RESPONSE` |
| x402 v1 | 402 JSON body (`x402Version: 1`) | `X-PAYMENT` | `X-PAYMENT-RESPONSE` |

Both rails carry the same offer and settle the same way: a v1 `base` payer signs
the same EIP-3009 authorization a v2 `eip155:8453` payer signs, so only the
envelope differs. Every payment is verified against this server's own
requirement, never against anything the client supplies.

Base x402 settlements are verified by the free-tier [PayAI](https://facilitator.payai.network) facilitator. Native MPP is negotiated by `mppx`. Recipient (`payTo`): `0x3D98800c64C345950E1eAaa076D88C12d1BF5F37`.

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

The transport is stateless — no session id is issued or required, and every
request is independent. `initialize` and `tools/list` are free. An unpaid
`tools/call` returns an x402 payment-required payload in `result.content[0].text`
(and `result.structuredContent`); attach the signed payment as
`params._meta["x402/payment"]` and repeat the call.

If you use an x402-aware MCP client, `@x402/mcp` handles that exchange for you.

## Tools

| MCP name           | REST path               | Arguments                          | Returns |
| ------------------ | ----------------------- | ---------------------------------- | ------- |
| `repair_json`      | `POST /repair/json`     | `{input}`                          | repaired JSON + which fixes applied |
| `yaml_to_json`     | `POST /yaml/tojson`     | `{input}`                          | parsed value + warnings |
| `cron_next_run`    | `POST /cron/nextrun`    | `{expr, after?}`                   | next UTC fire time |
| `text_diff`        | `POST /diff`            | `{old, new, context?}`             | unified diff + counts |
| `text_extract`     | `POST /text/extract`    | `{input, numbers?, codeBlocks?}`   | text, title, headings, links, URLs, emails |
| `domain_whois`     | `POST /domain/whois`    | `{domain}`                         | registrar, statuses, expiry, nameservers, DNSSEC |
| `dns_lookup`       | `POST /dns/lookup`      | `{domain, type?}`                  | DoH answers for A/AAAA/CNAME/MX/TXT/NS/SOA/PTR/SRV/CAA |
| `github_repo_stats`| `POST /github/repo-stats`| `{repo}`                          | stars, forks, open issues, language, license |
| `email_validate`   | `POST /email/validate`  | `{email}`                          | syntax + live MX deliverability |

`POST /diagnose` is free: it classifies what is wrong with a malformed JSON
payload without returning the repaired output, so a caller can check whether
paying is worthwhile before paying.

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

`wrapFetchWithPayment` handles the 402 round-trip: it receives the requirement,
signs the USDC authorization, retries, and only returns a `200` once the
facilitator has settled.

## Development

```bash
npm install
npm test              # 171 tests, runs fully offline (facilitator + upstream are injected)
npm run test:client   # 19 client tests
npx wrangler dev
npm run domain example.com   # point a custom domain at the Worker
npm run ship                 # pull, install, deploy
```

Environment (set in `wrangler.toml`): `X402_NETWORK`, `X402_FACILITATOR`,
`X402_PRICE`, `X402_PAY_TO`, and optionally `CANONICAL_HOST` — set that to a
custom domain once one points at the Worker, so it and the `workers.dev` host
name the same canonical page instead of competing as duplicates. Production also has an encrypted Cloudflare secret
`MPP_SECRET_KEY` used only to authenticate MPP challenges. Wallet private keys are
never deployed to the Worker.

## Maintainer

GitHub: [@danielarif26](https://github.com/danielarif26)
