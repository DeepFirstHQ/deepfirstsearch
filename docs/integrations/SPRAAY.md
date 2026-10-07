# Spraay + Agent Safe: AI gateway calls with a hard cap

Spraay's x402 gateway gives agents AI models and tools behind one endpoint, paid per call in USDC on Base. Agent Safe adds the guardrail people need before leaving an agent running: payments go **only to Spraay's address, never above your per-call cap, never past the budget**, whatever the agent was told.

**Tested live on Base mainnet (2026-10-07):** an agent paid Spraay 0.001 USDC for `GET /api/v1/models` and got the gateway's model list. [Transaction](https://basescan.org/tx/0x544c9d25291d9c8d47f873bf9f5769c757d5edb14408e09c6ccf5c8bdf058eba). The same 402 checked against a different payee was refused with zero signatures.

## 1. Add Spraay as a merchant

```ts
import { createAgentPay, MerchantRegistry } from "@deepfirstsearch/agent-pay";

const registry = new MerchantRegistry([{
  origin: "https://gateway.spraay.app",
  payTo: "0xAd62f03C7514bb8c51f1eA70C2b75C37404695c8", // Spraay's Base address, as in its 402
  network: "eip155:8453",
  maxPerTx: 2_000n, // never more than 0.002 USDC per call
  pricePin: 1_000n, // 0.001 USDC, the published price
  label: "Spraay",
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
const plan = pay.commitPlan([{ origin: "https://gateway.spraay.app", maxSpend: 100_000n }], 60 * 60_000);

const res = await pay.fetch("https://gateway.spraay.app/api/v1/models", { method: "GET" }, { plan });
console.log(res.status, res.payment?.settlement.transaction);
```

A 402 that asks for a different payee, a higher price or a different network is refused before anything is signed. Requires `@deepfirstsearch/agent-pay` 0.5.3 or later.

## 3. Or through MCP (Claude, Cursor, OpenClaw)

Add to the merchants of your [agent-pay-mcp](https://github.com/DeepFirstHQ/deepfirstsearch/tree/main/integrations/mcp) config, then ask the agent to use `https://gateway.spraay.app/api/v1/models`:

```json
{ "origin": "https://gateway.spraay.app", "label": "Spraay", "payTo": "0xAd62f03C7514bb8c51f1eA70C2b75C37404695c8",
  "price": "0.001", "maxPerTx": "0.002", "maxSpend": "1.00" }
```

Source, issues and the full SDK: [github.com/DeepFirstHQ/deepfirstsearch](https://github.com/DeepFirstHQ/deepfirstsearch). Questions or a merchant you'd like covered: [Discussions](https://github.com/DeepFirstHQ/deepfirstsearch/discussions).

> Agent Safe is an independent open-source project (MIT), live on Base mainnet as an unaudited beta. Not affiliated with Spraay.
