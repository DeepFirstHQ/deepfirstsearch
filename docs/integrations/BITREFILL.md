# Bitrefill + Agent Safe: gift-card catalog for agents, with a hard cap

Bitrefill lets agents browse and buy gift cards over x402, paid in USDC on Base. Agent Safe adds the guardrail people need before leaving an agent running: payments go **only to Bitrefill's address, never above your per-call cap, never past the budget**, whatever the agent was told.

**Tested live on Base mainnet (2026-10-07):** an agent paid Bitrefill 0.001 USDC for `GET /x402/products/detail?slug=amazon_com-usa` and got the Amazon.com USA product details. [Transaction](https://basescan.org/tx/0x204398ca403912c98209a5d999a9d056be662d0fd573214e29f2bba1d5a7d9bc). The same 402 checked against a different payee was refused with zero signatures.

## 1. Add Bitrefill as a merchant

```ts
import { createAgentPay, MerchantRegistry } from "@deepfirstsearch/agent-pay";

const registry = new MerchantRegistry([{
  origin: "https://api.bitrefill.com",
  payTo: "0x480CD46E6faDe651a0437DeaddA53D5c8e7D846A", // Bitrefill's Base address, as in its 402
  network: "eip155:8453",
  maxPerTx: 2_000n, // never more than 0.002 USDC per call
  pricePin: 1_000n, // 0.001 USDC, the published price
  label: "Bitrefill",
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
const plan = pay.commitPlan([{ origin: "https://api.bitrefill.com", maxSpend: 100_000n }], 60 * 60_000);

const res = await pay.fetch("https://api.bitrefill.com/x402/products/detail?slug=amazon_com-usa", { method: "GET" }, { plan });
console.log(res.status, res.payment?.settlement.transaction);
```

A 402 that asks for a different payee, a higher price or a different network is refused before anything is signed. Requires `@deepfirstsearch/agent-pay` 0.5.3 or later.

## 3. Or through MCP (Claude, Cursor, OpenClaw)

Add to the merchants of your [agent-pay-mcp](https://github.com/DeepFirstHQ/deepfirstsearch/tree/main/integrations/mcp) config, then ask the agent to use `https://api.bitrefill.com/x402/products/detail?slug=amazon_com-usa`:

```json
{ "origin": "https://api.bitrefill.com", "label": "Bitrefill", "payTo": "0x480CD46E6faDe651a0437DeaddA53D5c8e7D846A",
  "price": "0.001", "maxPerTx": "0.002", "maxSpend": "1.00" }
```

Source, issues and the full SDK: [github.com/DeepFirstHQ/deepfirstsearch](https://github.com/DeepFirstHQ/deepfirstsearch). Questions or a merchant you'd like covered: [Discussions](https://github.com/DeepFirstHQ/deepfirstsearch/discussions).

> Agent Safe is an independent open-source project (MIT), live on Base mainnet as an unaudited beta. Not affiliated with Bitrefill.
