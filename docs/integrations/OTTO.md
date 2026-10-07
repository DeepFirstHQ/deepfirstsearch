# Otto AI + Agent Safe: crypto news briefs for agents, capped

Otto AI's agent swarm sells crypto market briefs to agents over x402, paid per call in USDC on Base. Agent Safe adds the guardrail people need before leaving an agent running: payments go **only to Otto AI's address, never above your per-call cap, never past the budget**, whatever the agent was told.

**Tested live on Base mainnet (2026-10-07):** an agent paid Otto AI 0.001 USDC for `GET /crypto-news` and got the current crypto market brief. [Transaction](https://basescan.org/tx/0x69db0ab2353be694eaedc32f9a7775eed6f7729fc7e45380a73025c6e72578ec). The same 402 checked against a different payee was refused with zero signatures.

## 1. Add Otto AI as a merchant

```ts
import { createAgentPay, MerchantRegistry } from "@deepfirstsearch/agent-pay";

const registry = new MerchantRegistry([{
  origin: "https://x402.ottoai.services",
  payTo: "0x0E84dDEdAaE6A779c462C22a59F301EC31B6b808", // Otto AI's Base address, as in its 402
  network: "eip155:8453",
  maxPerTx: 2_000n, // never more than 0.002 USDC per call
  pricePin: 1_000n, // 0.001 USDC, the published price
  label: "Otto AI",
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
const plan = pay.commitPlan([{ origin: "https://x402.ottoai.services", maxSpend: 100_000n }], 60 * 60_000);

const res = await pay.fetch("https://x402.ottoai.services/crypto-news", { method: "GET" }, { plan });
console.log(res.status, res.payment?.settlement.transaction);
```

A 402 that asks for a different payee, a higher price or a different network is refused before anything is signed. Requires `@deepfirstsearch/agent-pay` 0.5.3 or later.

## 3. Or through MCP (Claude, Cursor, OpenClaw)

Add to the merchants of your [agent-pay-mcp](https://github.com/DeepFirstHQ/deepfirstsearch/tree/main/integrations/mcp) config, then ask the agent to use `https://x402.ottoai.services/crypto-news`:

```json
{ "origin": "https://x402.ottoai.services", "label": "Otto AI", "payTo": "0x0E84dDEdAaE6A779c462C22a59F301EC31B6b808",
  "price": "0.001", "maxPerTx": "0.002", "maxSpend": "1.00" }
```

> Agent Safe is an independent open-source project (MIT), live on Base mainnet as an unaudited beta. Not affiliated with Otto AI.
