# Glim (Cascade) + Agent Safe: live web data for agents, inside a budget

Glim (surf.cascade.fyi, the API behind Cascade's x402-proxy) serves live Twitter, Reddit, GitHub and web data to agents over x402, paid per call in USDC on Base. Agent Safe adds the guardrail people need before leaving an agent running: payments go **only to Glim (Cascade)'s address, never above your per-call cap, never past the budget**, whatever the agent was told.

**Tested live on Base mainnet (2026-10-09):** an agent paid Glim (Cascade) 0.002 USDC for `GET /api/v1/web/fetch/https://x402.org` and got the extracted content of x402.org. [Transaction](https://basescan.org/tx/0xc5ecd5a8eb4a5983f4ea139802ab5004ed2f2322bcff22fa68dedebf7f8b8db2). The same 402 checked against a different payee was refused with zero signatures.

## 1. Add Glim (Cascade) as a merchant

```ts
import { createAgentPay, MerchantRegistry } from "@deepfirstsearch/agent-pay";

const registry = new MerchantRegistry([{
  origin: "https://surf.cascade.fyi",
  payTo: "0xC751344Ee09B5159160173F77D4a1169bCd386A1", // Glim (Cascade)'s Base address, as in its 402
  network: "eip155:8453",
  maxPerTx: 5_000n, // never more than 0.005 USDC per call
  pricePin: 2_000n, // 0.002 USDC, the published price
  label: "Glim (Cascade)",
}]);
```

## 2. Pay per call

```ts
import { usdcAuthorizationCheck } from "@deepfirstsearch/agent-pay";
import { createPublicClient, http } from "viem";
import { base } from "viem/chains";

const pay = createAgentPay({
  registry,
  policy: { allowedNetworks: ["eip155:8453"], periodBudget: { amount: 1_000_000n, periodMs: 86_400_000 } },
  payer: () => yourWallet, // any viem account: local key, Turnkey, Privy, CDP, KMS
  // Glim (Cascade)'s receipt is not in the standard x402 form, so the SDK confirms the payment with USDC on-chain:
  confirmAuthorization: usdcAuthorizationCheck({ "eip155:8453": createPublicClient({ chain: base, transport: http() }) }),
  session: { readsUntrustedInput: true, accessesSensitiveData: false, canPay: true },
});
const plan = pay.commitPlan([{ origin: "https://surf.cascade.fyi", maxSpend: 100_000n }], 60 * 60_000);

const res = await pay.fetch("https://surf.cascade.fyi/api/v1/web/fetch/https://x402.org", { method: "GET" }, { plan });
console.log(res.status, res.payment?.confirmedOnChain ? "confirmed on-chain" : res.payment?.settlement.transaction);
```

A 402 that asks for a different payee, a higher price or a different network is refused before anything is signed. Requires `@deepfirstsearch/agent-pay` 0.6.3 or later.

> Agent Safe is an independent open-source project (MIT), live on Base mainnet as an unaudited beta. Not affiliated with Glim (Cascade).
