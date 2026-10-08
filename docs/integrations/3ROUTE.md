# 3Route + Agent Safe: swap quotes for agents, inside a budget

3Route serves DEX aggregation quotes to agents over x402, paid per call in USDC on Base. Agent Safe adds the guardrail people need before leaving an agent running: payments go **only to 3Route's address, never above your per-call cap, never past the budget**, whatever the agent was told.

**Tested live on Base mainnet (2026-10-08):** an agent paid 3Route 0.001 USDC for `GET /v1/8453/quote?src=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913&dst=0x4200000000000000000000000000000000000006&amount=1000000` and got a live USDC to WETH quote on Base. [Transaction](https://basescan.org/tx/0x6b89befbe3ec8ab827d3ebb01b334c0729a4888841e5d74ae8136f7459827f02). The same 402 checked against a different payee was refused with zero signatures.

## 1. Add 3Route as a merchant

```ts
import { createAgentPay, MerchantRegistry } from "@deepfirstsearch/agent-pay";

const registry = new MerchantRegistry([{
  origin: "https://api.3route.io",
  payTo: "0x5D89060682fcE50eCaa7600aF6A5645Bd2b107Eb", // 3Route's Base address, as in its 402
  network: "eip155:8453",
  maxPerTx: 2_000n, // never more than 0.002 USDC per call
  pricePin: 1_000n, // 0.001 USDC, the published price
  label: "3Route",
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
const plan = pay.commitPlan([{ origin: "https://api.3route.io", maxSpend: 100_000n }], 60 * 60_000);

const res = await pay.fetch("https://api.3route.io/v1/8453/quote?src=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913&dst=0x4200000000000000000000000000000000000006&amount=1000000", { method: "GET" }, { plan });
console.log(res.status, res.payment?.settlement.transaction);
```

A 402 that asks for a different payee, a higher price or a different network is refused before anything is signed. Requires `@deepfirstsearch/agent-pay` 0.5.3 or later.

## 3. Or through MCP (Claude, Cursor, OpenClaw)

Add to the merchants of your [agent-pay-mcp](https://github.com/DeepFirstHQ/deepfirstsearch/tree/main/integrations/mcp) config, then ask the agent to use `https://api.3route.io/v1/8453/quote?src=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913&dst=0x4200000000000000000000000000000000000006&amount=1000000`:

```json
{ "origin": "https://api.3route.io", "label": "3Route", "payTo": "0x5D89060682fcE50eCaa7600aF6A5645Bd2b107Eb",
  "price": "0.001", "maxPerTx": "0.002", "maxSpend": "1.00" }
```

> Agent Safe is an independent open-source project (MIT), live on Base mainnet as an unaudited beta. Not affiliated with 3Route.
