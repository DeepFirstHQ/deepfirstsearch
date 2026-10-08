# OpenWeb Ninja + Agent Safe: Google AI Mode for agents, inside a budget

OpenWeb Ninja serves real-time web data APIs, like Google AI Mode answers, to agents over x402, paid per call in USDC on Base. Agent Safe adds the guardrail people need before leaving an agent running: payments go **only to OpenWeb Ninja's address, never above your per-call cap, never past the budget**, whatever the agent was told.

**Tested live on Base mainnet (2026-10-08):** an agent paid OpenWeb Ninja 0.005 USDC for `GET /google-ai-mode/ai-mode?prompt=What%20is%20Base%20L2%3F` and got a Google AI Mode answer to "What is Base L2?". [Transaction](https://basescan.org/tx/0x8630b87d5155cb81754f4ee1e0092e9fcdc30f22773a74d0fee4571dcfdc1fcc). The same 402 checked against a different payee was refused with zero signatures.

## 1. Add OpenWeb Ninja as a merchant

```ts
import { createAgentPay, MerchantRegistry } from "@deepfirstsearch/agent-pay";

const registry = new MerchantRegistry([{
  origin: "https://x402.openwebninja.com",
  payTo: "0x3e7c9cA818f713F19e126E3B7B37B47dC1411570", // OpenWeb Ninja's Base address, as in its 402
  network: "eip155:8453",
  maxPerTx: 10_000n, // never more than 0.01 USDC per call
  pricePin: 5_000n, // 0.005 USDC, the published price
  label: "OpenWeb Ninja",
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
const plan = pay.commitPlan([{ origin: "https://x402.openwebninja.com", maxSpend: 100_000n }], 60 * 60_000);

const res = await pay.fetch("https://x402.openwebninja.com/google-ai-mode/ai-mode?prompt=What%20is%20Base%20L2%3F", { method: "GET" }, { plan });
console.log(res.status, res.payment?.settlement.transaction);
```

A 402 that asks for a different payee, a higher price or a different network is refused before anything is signed. Requires `@deepfirstsearch/agent-pay` 0.5.3 or later.

## 3. Or through MCP (Claude, Cursor, OpenClaw)

Add to the merchants of your [agent-pay-mcp](https://github.com/DeepFirstHQ/deepfirstsearch/tree/main/integrations/mcp) config, then ask the agent to use `https://x402.openwebninja.com/google-ai-mode/ai-mode?prompt=What%20is%20Base%20L2%3F`:

```json
{ "origin": "https://x402.openwebninja.com", "label": "OpenWeb Ninja", "payTo": "0x3e7c9cA818f713F19e126E3B7B37B47dC1411570",
  "price": "0.005", "maxPerTx": "0.01", "maxSpend": "1.00" }
```

> Agent Safe is an independent open-source project (MIT), live on Base mainnet as an unaudited beta. Not affiliated with OpenWeb Ninja.
