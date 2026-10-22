# @deepfirstsearch/agent-pay-cloudflare

**Agent Safe for the [Cloudflare Agents SDK](https://developers.cloudflare.com/agents/).** The Agents SDK lets an
agent pay for paid MCP tools over x402 with [`withX402Client`](https://developers.cloudflare.com/agents/tools/payments/x402/),
which asks a confirmation callback whether each payment may go ahead. This package *is* that callback, built from the
owner's rules — so the agent, even prompt-injected, can only ever pay the payee you pinned, on the network you allow,
in USDC, within a per-call cap, a price pin and a session budget. Anything else is refused and the client signs nothing.

MIT. No new runtime dependency — it reads the payment, it never holds your key.

## Install

```bash
npm i @deepfirstsearch/agent-pay-cloudflare @deepfirstsearch/agent-pay agents viem
```

## Connect

A wrapped client talks to one MCP server, so you give it that server's rules once:

```ts
import { withX402Client } from "agents/x402";
import { privateKeyToAccount } from "viem/accounts";
import { agentSafeConfirmation } from "@deepfirstsearch/agent-pay-cloudflare";

// 1. The owner's rules for the one MCP server this client pays.
const merchant = {
  origin: "https://mcp.example.com", // a label for this server
  payTo: "0xYourMerchant0000000000000000000000000000", // the ONLY address this client may pay
  network: "eip155:8453",            // Base
  maxPerTx: 50_000n,                 // ≤ 0.05 USDC per call (atomic units, USDC has 6 decimals)
  pricePin: 10_000n,                 // expected 0.01 USDC; anything above is refused
} as const;

// 2. Wrap your MCP client. Agent Safe decides every payment.
const client = withX402Client(mcpClient, {
  account: privateKeyToAccount(env.AGENT_PRIVATE_KEY),
  network: "eip155:8453",            // pin the network the client pays on
  confirmationCallback: agentSafeConfirmation({
    merchant,
    sessionBudget: 100_000n,         // ≤ 0.10 USDC total for this client's session
  }),
});

// 3. The agent calls tools. A tool that asks for payment is paid only inside the rules;
//    a swapped payee, a price hike, a different network or token is refused — nothing signed.
const result = await client.callTool(null, { name: "get_report", arguments: { ticker: "ETH" } });
```

`merchant` uses the same `Merchant` shape as the rest of Agent Safe, so if you already configure a
`MerchantRegistry` elsewhere you can reuse the same object here.

## Options

| Option | Type | Meaning |
|---|---|---|
| `merchant` | `Merchant` | **Required.** `payTo`, `network`, `maxPerTx`, and optional `pricePin`, `toleranceBps`, `maxTimeoutSeconds`. |
| `sessionBudget` | `bigint` | Total this client may spend across the session, in atomic units. Omit for no session cap. |
| `allowedNetworks` | `string[]` | Networks a payment may be on (CAIP-2 or legacy name). Default: the merchant's network only. |
| `onRefusal` | `(r) => void` | Called with `{ code, detail }` each time a payment is refused — for logs/metrics. |

## What it refuses

A payment is approved only if **every** option the `402` offers is within policy (the client, not the callback,
chooses which option to pay — so one unsafe option taints the whole `402`). It refuses, with a stable code:

`payee_mismatch` · `network_not_allowed` · `asset_not_allowed` (a token that isn't the pinned USDC — the "declared
decimals" trick) · `over_cap` · `price_changed` · `window_too_long` · `budget_exhausted`.

## See also

- Check what an x402 client signs **unguarded**, in one command: `npx @deepfirstsearch/x402-scan client @x402/fetch`
- The rest of Agent Safe (SDK, other framework tools, on-chain budgets): <https://deepfirstsearch.com/developers>
