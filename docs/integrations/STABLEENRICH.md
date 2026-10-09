# StableEnrich + Agent Safe: AgentCash's data APIs, paid inside a budget

StableEnrich (Merit Systems, the AgentCash team) sells Exa, Firecrawl, Google Maps and enrichment APIs to agents over x402, paid per call in USDC on Base. Agent Safe adds the guardrail people need before leaving an agent running: payments go **only to StableEnrich's address, never above your per-call cap, never past the budget**, whatever the agent was told.

**Tested live on Base mainnet (2026-10-09):** an agent paid StableEnrich 0.002 USDC for `POST /api/exa/contents` and got the clean text and a summary of x402.org from Exa. [Transaction](https://basescan.org/tx/0x94faadc17d48f9340c8d049ccbaa12ed4e709a5f704cccf288b13dfe66439315). The same 402 checked against a different payee was refused with zero signatures.

## 1. Add StableEnrich as a merchant

```ts
import { createAgentPay, MerchantRegistry } from "@deepfirstsearch/agent-pay";

const registry = new MerchantRegistry([{
  origin: "https://stableenrich.dev",
  payTo: "0x325bdF6F7efAB24a2210c48c1b64cAb2eAe1d430", // StableEnrich's Base address, as in its 402
  network: "eip155:8453",
  maxPerTx: 5_000n, // never more than 0.005 USDC per call
  pricePin: 2_000n, // 0.002 USDC, the published price
  label: "StableEnrich",
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
const plan = pay.commitPlan([{ origin: "https://stableenrich.dev", maxSpend: 100_000n }], 60 * 60_000);

const res = await pay.fetch("https://stableenrich.dev/api/exa/contents", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({"urls": ["https://x402.org"], "text": {"maxCharacters": 1000}, "summary": {}}),
}, { plan });
console.log(res.status, res.payment?.settlement.transaction);
```

A 402 that asks for a different payee, a higher price or a different network is refused before anything is signed. Requires `@deepfirstsearch/agent-pay` 0.5.3 or later.

## 3. Or through MCP (Claude, Cursor, OpenClaw)

Add to the merchants of your [agent-pay-mcp](https://github.com/DeepFirstHQ/deepfirstsearch/tree/main/integrations/mcp) config, then ask the agent to use `https://stableenrich.dev/api/exa/contents`:

```json
{ "origin": "https://stableenrich.dev", "label": "StableEnrich", "payTo": "0x325bdF6F7efAB24a2210c48c1b64cAb2eAe1d430",
  "price": "0.002", "maxPerTx": "0.005", "maxSpend": "1.00" }
```

> Agent Safe is an independent open-source project (MIT), live on Base mainnet as an unaudited beta. Not affiliated with StableEnrich.
