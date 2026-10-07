# Pocket Network + Agent Safe: web extraction for agents, capped

Pocket Network's agent API extracts web pages for agents over x402, paid per call in USDC on Base. Agent Safe adds the guardrail people need before leaving an agent running: payments go **only to Pocket Network's address, never above your per-call cap, never past the budget**, whatever the agent was told.

**Tested live on Base mainnet (2026-10-07):** an agent paid Pocket Network 0.005 USDC for `POST /v1/agentsearch-web-extract-v1` and got the extracted text of a web page. [Transaction](https://basescan.org/tx/0xcaf1de06f99e26d288a427f7cd1f35def667c82354d6e70981d2e55c4014591e). The same 402 checked against a different payee was refused with zero signatures.

## 1. Add Pocket Network as a merchant

```ts
import { createAgentPay, MerchantRegistry } from "@deepfirstsearch/agent-pay";

const registry = new MerchantRegistry([{
  origin: "https://agent.pocket.network",
  payTo: "0xF732ea490c5766071785a2310523f7fA2CEbB829", // Pocket Network's Base address, as in its 402
  network: "eip155:8453",
  maxPerTx: 10_000n, // never more than 0.01 USDC per call
  pricePin: 5_000n, // 0.005 USDC, the published price
  label: "Pocket Network",
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
const plan = pay.commitPlan([{ origin: "https://agent.pocket.network", maxSpend: 100_000n }], 60 * 60_000);

const res = await pay.fetch("https://agent.pocket.network/v1/agentsearch-web-extract-v1", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({"url": "https://example.com"}),
}, { plan });
console.log(res.status, res.payment?.settlement.transaction);
```

A 402 that asks for a different payee, a higher price or a different network is refused before anything is signed. Requires `@deepfirstsearch/agent-pay` 0.5.3 or later.

## 3. Or through MCP (Claude, Cursor, OpenClaw)

Add to the merchants of your [agent-pay-mcp](https://github.com/DeepFirstHQ/deepfirstsearch/tree/main/integrations/mcp) config, then ask the agent to use `https://agent.pocket.network/v1/agentsearch-web-extract-v1`:

```json
{ "origin": "https://agent.pocket.network", "label": "Pocket Network", "payTo": "0xF732ea490c5766071785a2310523f7fA2CEbB829",
  "price": "0.005", "maxPerTx": "0.01", "maxSpend": "1.00" }
```

Source, issues and the full SDK: [github.com/DeepFirstHQ/deepfirstsearch](https://github.com/DeepFirstHQ/deepfirstsearch). Questions or a merchant you'd like covered: [Discussions](https://github.com/DeepFirstHQ/deepfirstsearch/discussions).

> Agent Safe is an independent open-source project (MIT), live on Base mainnet as an unaudited beta. Not affiliated with Pocket Network.
