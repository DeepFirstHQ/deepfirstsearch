# Particle + Agent Safe: news intelligence for agents, inside a budget

Particle serves its news and topic intelligence to agents over x402, paid per call in USDC on Base. Agent Safe adds the guardrail people need before leaving an agent running: payments go **only to Particle's address, never above your per-call cap, never past the budget**, whatever the agent was told.

**Tested live on Base mainnet (2026-10-08):** an agent paid Particle 0.01 USDC for `GET /v1/topics` and got the live Particle topic list. [Transaction](https://basescan.org/tx/0x337fb16886b4c406773cf6e0a33efae50b1380fd9b59cf3cfe6d87dfd6cf2020). The same 402 checked against a different payee was refused with zero signatures.

## 1. Add Particle as a merchant

```ts
import { createAgentPay, MerchantRegistry } from "@deepfirstsearch/agent-pay";

const registry = new MerchantRegistry([{
  origin: "https://api.particle.pro",
  payTo: "0x59f3a6dcb6f482c53872dd8f8f9e1f9161a1c5f7", // Particle's Base address, as in its 402
  network: "eip155:8453",
  maxPerTx: 20_000n, // never more than 0.02 USDC per call
  pricePin: 10_000n, // 0.01 USDC, the published price
  label: "Particle",
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
const plan = pay.commitPlan([{ origin: "https://api.particle.pro", maxSpend: 100_000n }], 60 * 60_000);

const res = await pay.fetch("https://api.particle.pro/v1/topics", { method: "GET" }, { plan });
console.log(res.status, res.payment?.settlement.transaction);
```

A 402 that asks for a different payee, a higher price or a different network is refused before anything is signed. Requires `@deepfirstsearch/agent-pay` 0.5.3 or later.

## 3. Or through MCP (Claude, Cursor, OpenClaw)

Add to the merchants of your [agent-pay-mcp](https://github.com/DeepFirstHQ/deepfirstsearch/tree/main/integrations/mcp) config, then ask the agent to use `https://api.particle.pro/v1/topics`:

```json
{ "origin": "https://api.particle.pro", "label": "Particle", "payTo": "0x59f3a6dcb6f482c53872dd8f8f9e1f9161a1c5f7",
  "price": "0.01", "maxPerTx": "0.02", "maxSpend": "1.00" }
```

> Agent Safe is an independent open-source project (MIT), live on Base mainnet as an unaudited beta. Not affiliated with Particle.
