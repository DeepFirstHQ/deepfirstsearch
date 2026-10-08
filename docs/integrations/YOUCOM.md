# You.com + Agent Safe: web search for agents, inside a budget

You.com serves LLM-ready web search to agents over x402, paid per query in USDC on Base. Agent Safe adds the guardrail people need before leaving an agent running: payments go **only to You.com's address, never above your per-call cap, never past the budget**, whatever the agent was told.

**Tested live on Base mainnet (2026-10-08):** an agent paid You.com 0.005 USDC for `GET /v1/search?query=base%20l2&count=5` and got five live web results for "base l2". [Transaction](https://basescan.org/tx/0xb70eea7fd8dfa1702689f14da5dffcdad1b24fe006283529f36c813921094bad). The same 402 checked against a different payee was refused with zero signatures.

## 1. Add You.com as a merchant

```ts
import { createAgentPay, MerchantRegistry } from "@deepfirstsearch/agent-pay";

const registry = new MerchantRegistry([{
  origin: "https://api.you.com",
  payTo: "0xc327D0aEb5f65B514b193b5e5A95cC6F4060815f", // You.com's Base address, as in its 402
  network: "eip155:8453",
  maxPerTx: 10_000n, // never more than 0.01 USDC per call
  pricePin: 5_000n, // 0.005 USDC, the published price
  label: "You.com",
}]);
```

## 2. Pay per call

```ts
const pay = createAgentPay({
  registry,
  policy: { allowedNetworks: ["eip155:8453"], periodBudget: { amount: 1_000_000n, periodMs: 86_400_000 }, timeoutBounds: { min: 10, max: 600 } }, // You.com asks for 10-minute authorizations
  payer: () => yourWallet, // any viem account: local key, Turnkey, Privy, CDP, KMS
  session: { readsUntrustedInput: true, accessesSensitiveData: false, canPay: true },
});
const plan = pay.commitPlan([{ origin: "https://api.you.com", maxSpend: 100_000n }], 60 * 60_000);

const res = await pay.fetch("https://api.you.com/v1/search?query=base%20l2&count=5", { method: "GET" }, { plan });
console.log(res.status, res.payment?.settlement.transaction);
```

A 402 that asks for a different payee, a higher price or a different network is refused before anything is signed. Requires `@deepfirstsearch/agent-pay` 0.5.3 or later.

> Agent Safe is an independent open-source project (MIT), live on Base mainnet as an unaudited beta. Not affiliated with You.com.
