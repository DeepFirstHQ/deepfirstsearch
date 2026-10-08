# Hey Elsa + Agent Safe: DeFi actions for agents, inside a budget

Hey Elsa serves DeFi data and actions (prices, portfolios, swaps, limit orders, perps) to agents over x402, paid per call in USDC on Base, and ships agent skills that call it. Agent Safe adds the guardrail people need before leaving an agent running: payments go **only to Hey Elsa's address, never above your per-call cap, never past the budget**, whatever the agent was told.

**Tested live on Base mainnet (2026-10-08):** an agent paid Hey Elsa 0.002 USDC for `POST /api/get_token_price` and got the live WETH price on Base. [Transaction](https://basescan.org/tx/0x8cea086578c8da6bb36f345222cfccfc06910de1bda7fef2895aa0ddcddaccff). The same 402 checked against a different payee was refused with zero signatures.

## 1. Add Hey Elsa as a merchant

```ts
import { createAgentPay, MerchantRegistry } from "@deepfirstsearch/agent-pay";

const registry = new MerchantRegistry([{
  origin: "https://x402-v2-api.heyelsa.ai",
  payTo: "0xEcB6175395806A3781AE7E5bae6d0abcB214Ee4D", // Hey Elsa's Base address, as in its 402
  network: "eip155:8453",
  maxPerTx: 10_000n, // never more than 0.01 USDC per call
  pricePin: 2_000n, // 0.002 USDC, the published price
  label: "Hey Elsa",
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
const plan = pay.commitPlan([{ origin: "https://x402-v2-api.heyelsa.ai", maxSpend: 100_000n }], 60 * 60_000);

const res = await pay.fetch("https://x402-v2-api.heyelsa.ai/api/get_token_price", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({"token_address": "0x4200000000000000000000000000000000000006", "chain": "base"}),
}, { plan });
console.log(res.status, res.payment?.settlement.transaction);
```

A 402 that asks for a different payee, a higher price or a different network is refused before anything is signed. Requires `@deepfirstsearch/agent-pay` 0.5.3 or later.

## 3. Or through MCP (Claude, Cursor, OpenClaw)

Add to the merchants of your [agent-pay-mcp](https://github.com/DeepFirstHQ/deepfirstsearch/tree/main/integrations/mcp) config, then ask the agent to use `https://x402-v2-api.heyelsa.ai/api/get_token_price`:

```json
{ "origin": "https://x402-v2-api.heyelsa.ai", "label": "Hey Elsa", "payTo": "0xEcB6175395806A3781AE7E5bae6d0abcB214Ee4D",
  "price": "0.002", "maxPerTx": "0.01", "maxSpend": "1.00" }
```

> Agent Safe is an independent open-source project (MIT), live on Base mainnet as an unaudited beta. Not affiliated with Hey Elsa.
