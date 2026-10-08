# CoinStats + Agent Safe: crypto market data for agents, inside a budget

CoinStats serves coin prices and market data to agents over x402, paid per call in USDC on Base. Agent Safe adds the guardrail people need before leaving an agent running: payments go **only to CoinStats's address, never above your per-call cap, never past the budget**, whatever the agent was told.

**Tested live on Base mainnet (2026-10-08):** an agent paid CoinStats 0.001 USDC for `GET /coins/bitcoin?currency=USD` and got the live Bitcoin price and market stats. [Transaction](https://basescan.org/tx/0x3e1bcb5a19498e384cee2dfb0b34bd3396721b3f0952f910e3df69f0ea62c9e7). The same 402 checked against a different payee was refused with zero signatures.

## 1. Add CoinStats as a merchant

```ts
import { createAgentPay, MerchantRegistry } from "@deepfirstsearch/agent-pay";

const registry = new MerchantRegistry([{
  origin: "https://x402.coinstats.app",
  payTo: "0xa2AD8183209E5d2F7f0d8F995f5601a0bb5100c7", // CoinStats's Base address, as in its 402
  network: "eip155:8453",
  maxPerTx: 2_000n, // never more than 0.002 USDC per call
  pricePin: 1_000n, // 0.001 USDC, the published price
  label: "CoinStats",
}]);
```

## 2. Pay per call

```ts
const pay = createAgentPay({
  registry,
  policy: { allowedNetworks: ["eip155:8453"], periodBudget: { amount: 1_000_000n, periodMs: 86_400_000 } },
  payer: () => yourWallet, // any viem account: local key, Turnkey, Privy, CDP, KMS
  session: { readsUntrustedInput: true, accessesSensitiveData: false, canPay: true },
});
const plan = pay.commitPlan([{ origin: "https://x402.coinstats.app", maxSpend: 100_000n }], 60 * 60_000);

const res = await pay.fetch("https://x402.coinstats.app/coins/bitcoin?currency=USD", { method: "GET" }, { plan });
console.log(res.status, res.payment?.settlement.transaction);
```

A 402 that asks for a different payee, a higher price or a different network is refused before anything is signed. Requires `@deepfirstsearch/agent-pay` 0.5.3 or later.

## 3. Or through MCP (Claude, Cursor, OpenClaw)

Add to the merchants of your [agent-pay-mcp](https://github.com/DeepFirstHQ/deepfirstsearch/tree/main/integrations/mcp) config, then ask the agent to use `https://x402.coinstats.app/coins/bitcoin?currency=USD`:

```json
{ "origin": "https://x402.coinstats.app", "label": "CoinStats", "payTo": "0xa2AD8183209E5d2F7f0d8F995f5601a0bb5100c7",
  "price": "0.001", "maxPerTx": "0.002", "maxSpend": "1.00" }
```

> Agent Safe is an independent open-source project (MIT), live on Base mainnet as an unaudited beta. Not affiliated with CoinStats.
