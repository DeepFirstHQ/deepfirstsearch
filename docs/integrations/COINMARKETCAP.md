# CoinMarketCap + Agent Safe: market data for agents, inside a budget

CoinMarketCap serves crypto and DEX market data to agents over x402, paid per call in USDC on Base. Agent Safe adds the guardrail people need before leaving an agent running: payments go **only to CoinMarketCap's address, never above your per-call cap, never past the budget**, whatever the agent was told.

**Tested live on Base mainnet (2026-10-08):** an agent paid CoinMarketCap 0.01 USDC for `GET /x402/v1/dex/search?q=weth` and got live DEX search results for WETH. [Transaction](https://basescan.org/tx/0xb4d1744d5ad4488548f6f1cc07773562a402c5cfe5cae5919e06e60ff38218cc). The same 402 checked against a different payee was refused with zero signatures.

## 1. Add CoinMarketCap as a merchant

```ts
import { createAgentPay, MerchantRegistry } from "@deepfirstsearch/agent-pay";

const registry = new MerchantRegistry([{
  origin: "https://pro-api.coinmarketcap.com",
  payTo: "0x3C5f3a6cE224BB89D72f5EB4232ecC27F67B3eeA", // CoinMarketCap's Base address, as in its 402
  network: "eip155:8453",
  maxPerTx: 20_000n, // never more than 0.02 USDC per call
  pricePin: 10_000n, // 0.01 USDC, the published price
  label: "CoinMarketCap",
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
  // CoinMarketCap's receipt is not in the standard x402 form, so the SDK confirms the payment with USDC on-chain:
  confirmAuthorization: usdcAuthorizationCheck({ "eip155:8453": createPublicClient({ chain: base, transport: http() }) }),
  session: { readsUntrustedInput: true, accessesSensitiveData: false, canPay: true },
});
const plan = pay.commitPlan([{ origin: "https://pro-api.coinmarketcap.com", maxSpend: 100_000n }], 60 * 60_000);

const res = await pay.fetch("https://pro-api.coinmarketcap.com/x402/v1/dex/search?q=weth", { method: "GET" }, { plan });
console.log(res.status, res.payment?.confirmedOnChain ? "confirmed on-chain" : res.payment?.settlement.transaction);
```

A 402 that asks for a different payee, a higher price or a different network is refused before anything is signed. Requires `@deepfirstsearch/agent-pay` 0.6.3 or later.

> Agent Safe is an independent open-source project (MIT), live on Base mainnet as an unaudited beta. Not affiliated with CoinMarketCap.
