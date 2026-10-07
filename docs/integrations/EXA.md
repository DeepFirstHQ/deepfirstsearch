# Exa + Agent Safe: agents that pay for search inside a budget

Exa sells search and contents to agents over x402: no API key, pay per request in USDC on Base. Agent Safe makes that safe to leave unattended: the agent pays **only Exa's address, only at Exa's price, only up to the budget you set**, and a prompt-injected agent can't redirect or inflate a payment.

**Tested live on Base mainnet (2026-10-07):** an agent paid Exa 0.004 USDC for an `instant` search and got its results. [Transaction](https://basescan.org/tx/0xad35b9a0bb64f2c5d7c79c3fca12bc393cfbd35b4b610a8500c3028199ec7c24).

## 1. Add Exa as a merchant

```ts
import { createAgentPay, MerchantRegistry } from "@deepfirstsearch/agent-pay";

const registry = new MerchantRegistry([{
  origin: "https://api.exa.ai",
  payTo: "0x6d6E695b09861467c7d462f5AAF31cF3540B9192", // Exa's Base address, as in its 402
  network: "eip155:8453",
  pricePin: 7_000n,  // 0.007 USDC (auto/fast search); instant is 0.004, deep 0.012
  maxPerTx: 12_000n, // hard cap per request
  label: "Exa search",
}]);
```

Exa's 402 also offers Solana and a batched gateway option; the SDK pays the standard Base USDC option and ignores the rest.

## 2. Pay per search

```ts
const pay = createAgentPay({
  registry,
  policy: { allowedNetworks: ["eip155:8453"], periodBudget: { amount: 1_000_000n, periodMs: 86_400_000 } },
  payer: () => yourWallet, // any viem account: local key, Turnkey, Privy, CDP…
  session: { readsUntrustedInput: true, accessesSensitiveData: false, canPay: true },
});
const plan = pay.commitPlan([{ origin: "https://api.exa.ai", maxSpend: 200_000n }], 60 * 60_000);

const res = await pay.fetch("https://api.exa.ai/search", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ query: "x402 spending limits", type: "auto", numResults: 5 }),
}, { plan });
```

## 3. Or give Claude/Cursor access through MCP

Add the merchant to the [MCP server](https://github.com/DeepFirstHQ/deepfirstsearch/tree/main/integrations/mcp) config and the agent can call `paid_fetch` on Exa without ever choosing the payee or the price:

```json
{ "origin": "https://api.exa.ai", "label": "Exa search", "payTo": "0x6d6E695b09861467c7d462f5AAF31cF3540B9192",
  "price": "0.007", "tolerancePct": 0, "maxPerTx": "0.012", "maxSpend": "1.00" }
```

For on-chain budgets (caps enforced by a contract even if the agent's machine is compromised), see the [owner CLI](https://github.com/DeepFirstHQ/deepfirstsearch/tree/main/sdk#owner-cli-vault-and-budgets-in-three-commands).

Source, issues and the full SDK: [github.com/DeepFirstHQ/deepfirstsearch](https://github.com/DeepFirstHQ/deepfirstsearch). Questions or a merchant you'd like covered: [Discussions](https://github.com/DeepFirstHQ/deepfirstsearch/discussions).

> Agent Safe is an independent open-source project (MIT), live on Base mainnet as an unaudited beta. Not affiliated with Exa.
