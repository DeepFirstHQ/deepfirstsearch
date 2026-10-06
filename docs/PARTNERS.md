# Partners: add safe payments to your agents in minutes

Your users' agents are starting to pay for APIs with x402. Agent Safe makes sure they can't be talked into paying the wrong address, the wrong price or more than the owner allowed, without changing the wallet you already run.

**We do the integration work with you, for free.** Email nicolas@deepfirstsearch.com.

## Three ways to integrate

| Level | What you add | What your users get | Effort |
|---|---|---|---|
| **1. Guard** | Wrap your agent's x402 calls with the SDK, using **your existing wallet signer** (Privy, Turnkey, Crossmint, Coinbase CDP, any viem account) | Merchant allowlist, pinned prices, a spending plan sealed before the agent reads anything untrusted, rate limits, a hash-chained audit log. Your signer is never even asked to sign an attack | ~10 lines, nothing on-chain |
| **2. On-chain budgets** | Users fund an Agent Safe vault they own; your agent key spends inside the budget they sign | Per-payment, per-day and per-merchant caps enforced by a contract on Base, a timelock on any new budget, instant pause and revoke, one payer address per merchant. Non-custodial: neither you nor we can move their funds | A day, with our help |
| **3. Drop-in** | Ship our MCP server, Vercel AI SDK tool or LangChain tool | All of the above inside Claude, Cursor, `generateText` or LangGraph | Configuration only |

### Level 1 in practice

```ts
import { createAgentPay, MerchantRegistry } from "@deepfirstsearch/agent-pay";

const pay = createAgentPay({
  registry: new MerchantRegistry([{
    origin: "https://api.example.com", payTo: "0x…",
    network: "eip155:8453", maxPerTx: 50_000n, pricePin: 10_000n,
  }]),
  policy: { allowedNetworks: ["eip155:8453"] },
  // Any viem account: your API, KMS or enclave signs.
  payer: () => yourWalletAccount,
  session: { readsUntrustedInput: true, accessesSensitiveData: false, canPay: true },
});

const plan = pay.commitPlan(
  [{ origin: "https://api.example.com", maxSpend: 1_000_000n }],
  60 * 60_000,
);
// Pays only if every check passes.
const res = await pay.fetch("https://api.example.com/data", {}, { plan });
```

A test in the repository (`sdk/test/external-signer.test.ts`) runs exactly this with a remote signer: an honest 402 is paid, and a 402 that swaps the payee is refused before the signer is called.

## What makes it different

- **The model never decides money.** Payee, price and limits come from the owner's configuration and signed budgets, never from the model or from a 402 response. Prompt injection can't widen them.
- **Enforced on-chain, not only in software.** If an agent machine is compromised, the vault still caps what it can spend.
- **Owner-signed, timelocked budgets.** Raising a limit waits out a public timelock; restricting is instant.
- **Per-merchant payer addresses.** Merchants can't link a user's purchases across services by address.
- **Open source (MIT), no API keys, no lock-in.** Use the pieces you need.

## What partners get

- An integration built with your team, and reviewed by us.
- A joint announcement and demo video (like [our Claude demo](https://x.com/DeepFirstHQ/status/2107579916799836312)).
- A listing on deepfirstsearch.com and in the repository.
- A direct line for support and roadmap input.

## Costs, plainly

Level 1 and the drop-in tools are free. On-chain budgets (level 2) carry a 0.1% protocol fee on top of each payment or top-up, paid by the vault. There is no integration fee.

## Status

Live on Base mainnet as an **unaudited beta** (small amounts), and on Base Sepolia for testing. Addresses: [DEPLOYMENTS.md](DEPLOYMENTS.md). Security reviews: [SECURITY.md](assessments/SECURITY.md).
