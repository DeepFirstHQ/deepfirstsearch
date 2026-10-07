# Nansen + Agent Safe: onchain intelligence for agents, inside a budget

Nansen sells onchain analytics to agents over x402, paid per call in USDC on Base. Agent Safe adds the guardrail people need before leaving an agent running: payments go **only to Nansen's address, never above your per-call cap, never past the budget**, whatever the agent was told.

**Tested live on Base mainnet (2026-10-07):** an agent paid Nansen 0.01 USDC for `POST /api/v1/nansen-score/top-tokens` and got Nansen Score's top large-cap tokens. [Transaction](https://basescan.org/tx/0x3b432e666c5766d92fd29ef0391aa8d3306888a40e0ba7d604a91a9f1c01f11a). The same 402 checked against a different payee was refused with zero signatures.

## 1. Add Nansen as a merchant

```ts
import { createAgentPay, MerchantRegistry } from "@deepfirstsearch/agent-pay";

const registry = new MerchantRegistry([{
  origin: "https://api.nansen.ai",
  payTo: "0x93053f1e7A5eFEDa532Fe69CbbE43cBEc3A0F13f", // Nansen's Base address, as in its 402
  network: "eip155:8453",
  maxPerTx: 20_000n, // never more than 0.02 USDC per call
  pricePin: 10_000n, // 0.01 USDC, the published price
  label: "Nansen",
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
const plan = pay.commitPlan([{ origin: "https://api.nansen.ai", maxSpend: 100_000n }], 60 * 60_000);

const res = await pay.fetch("https://api.nansen.ai/api/v1/nansen-score/top-tokens", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({"limit": 5, "market_cap_group": "largecap"}),
}, { plan });
console.log(res.status, res.payment?.settlement.transaction);
```

A 402 that asks for a different payee, a higher price or a different network is refused before anything is signed. Requires `@deepfirstsearch/agent-pay` 0.5.3 or later.

## 3. Or through MCP (Claude, Cursor, OpenClaw)

Add to the merchants of your [agent-pay-mcp](https://github.com/DeepFirstHQ/deepfirstsearch/tree/main/integrations/mcp) config, then ask the agent to use `https://api.nansen.ai/api/v1/nansen-score/top-tokens`:

```json
{ "origin": "https://api.nansen.ai", "label": "Nansen", "payTo": "0x93053f1e7A5eFEDa532Fe69CbbE43cBEc3A0F13f",
  "price": "0.01", "maxPerTx": "0.02", "maxSpend": "1.00" }
```

Source, issues and the full SDK: [github.com/DeepFirstHQ/deepfirstsearch](https://github.com/DeepFirstHQ/deepfirstsearch). Questions or a merchant you'd like covered: [Discussions](https://github.com/DeepFirstHQ/deepfirstsearch/discussions).

> Agent Safe is an independent open-source project (MIT), live on Base mainnet as an unaudited beta. Not affiliated with Nansen.
