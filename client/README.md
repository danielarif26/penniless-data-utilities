# Penniless Data Utilities client

An installable Node.js client for the ten Penniless Data Utilities. It handles
the x402 v2 `402 Payment Required` handshake, signs the USDC authorization in
your process, and retries a paid request once. Node.js 20 or newer is required.

Pure-compute calls cost **0.005 USDC**; network-backed calls cost **0.02 USDC**.
The client's default limit is **0.02 USDC**, matching the highest published tier.
Calls are paid with x402 v2 USDC on Base. The service grants one successful
free pure-compute trial per client in a rolling 24-hour window; network-backed
calls always require payment.

## Install

Once published, run it without a global install:

```sh
npx penniless-data-utilities-client --help
```

Until then, clone the repository and install the self-contained client package:

```sh
git clone --branch main https://github.com/danielarif26/penniless-data-utilities.git
cd penniless-data-utilities
npm install ./client
```

npm's `github:` shorthand installs the repository's root package, not a nested
package subdirectory. If your package manager supports Git package subpaths,
select `client/` from `github:danielarif26/penniless-data-utilities#main`;
otherwise the clone-and-install command above is the portable option. Client
dependencies remain inside `client/` and do not enlarge the Worker bundle.

Set the paying wallet key in the environment; do not put it in source code or
in the JSON argument:

```sh
export PDU_PRIVATE_KEY=0x...
pdu repair-json --json '{"input":"{foo: '\''bar'\'',}"}'
```

Run `pdu --help` for all tool names. `pdu verify` performs unpaid live checks
of the published payment requirements; it does not sign or settle a payment.

## MCP configuration

Claude Code (`.mcp.json`) and Claude Desktop
(`claude_desktop_config.json`) accept this streamable HTTP configuration:

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

`pdu mcp-config` prints the same ready-to-paste block. `initialize` and
`tools/list` are free. A paid `tools/call` needs an x402-aware MCP integration;
the JavaScript client below performs that paid MCP handshake directly.

## JavaScript

The module performs no network access when imported. `accountFromEnv()` reads
`PDU_PRIVATE_KEY` only when called; alternatively, pass a private-key string or
a viem account directly to `createPennilessClient`.

REST example:

```js
import {
  accountFromEnv,
  createPennilessClient,
} from "penniless-data-utilities-client";

const account = await accountFromEnv();
const pdu = createPennilessClient({ account });

const repaired = await pdu.tools.repairJson("{foo: 'bar',}");
console.log(repaired);
```

MCP example (the signed payment is attached at
`params._meta["x402/payment"]` by the client):

```js
import {
  accountFromEnv,
  createPennilessClient,
} from "penniless-data-utilities-client";

const account = await accountFromEnv();
const pdu = createPennilessClient({ account });

const result = await pdu.mcp.tool("cron_next_run", {
  expr: "*/15 * * * *",
});
console.log(result);
```

For tests or custom custody, inject
`signerAdapter.sign(requirement) -> paymentHeaderObject` instead of giving the
client a key. `health()`, `stats()`, and `diagnose(input)` are free and never
invoke the signer. `rawFetch()` returns the original `Response` unchanged.

## Network, payer, and balance

Payments are USDC on **Base mainnet** (`eip155:8453`), not Base Sepolia or
another testnet. The account represented by `PDU_PRIVATE_KEY`, `account`, or
your injected signer pays the service. It needs a small USDC balance. Signing
the authorization itself does not require Base ETH; the x402 facilitator
normally submits the settlement transaction. The receiving service never funds
the caller, and there is no faucet for mainnet funds.

Before and after a call, check the paying address in a wallet or on
[BaseScan](https://basescan.org/), and inspect its USDC token balance and recent
token transfers. Be sure you are viewing Base mainnet and the same address the
client uses. You can also query the official Base USDC contract with a wallet
or a public RPC; never paste a private key into an explorer or balance checker.

## Security

The key signs an EIP-712 USDC transfer authorization containing the recipient,
amount, nonce, and validity window. Before asking for that signature, the client
validates the x402 `exact` requirement's resource, Base network, asset, amount,
and recipient. The raw key never leaves the client process: it is not sent to
Penniless Data Utilities or the facilitator, and the client redacts it from
inspection. Only the signed payment object is sent. The default 0.02 USDC
tolerance refuses unexpectedly expensive payment requirements.

Use a dedicated, low-balance hot wallet rather than a primary wallet. Keep the
key in an environment variable or a proper secret manager, never in shell
history, config committed to Git, logs, issue reports, or `--json`. Review the
service URL, network, amount, asset, and `payTo` before raising the tolerance.
