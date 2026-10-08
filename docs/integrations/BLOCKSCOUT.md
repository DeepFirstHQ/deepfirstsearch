# Blockscout + Agent Safe: explorer data for agents, inside a budget

Blockscout serves block explorer data for many chains to agents over x402, paid per call in USDC on Base. Agent Safe adds the guardrail people need before leaving an agent running: payments go **only to Blockscout's address, never above your per-call cap, never past the budget**, whatever the agent was told.

**Tested live on Base mainnet (2026-10-08):** an agent paid Blockscout 0.002 USDC for `GET /8453/api/v2/tokens/0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` and got the USDC token record on Base (supply, holders, market data). [Transaction](https://basescan.org/tx/0xe44029e056762f64f8a71e1b6c97eda3f027456bf7556f0205fca7c92ebd464a). The same 402 checked against a different payee was refused with zero signatures.

## 1. Add Blockscout as a merchant

```ts
import { createAgentPay, MerchantRegistry } from "@deepfirstsearch/agent-pay";

const registry = new MerchantRegistry([{
  origin: "https://api.blockscout.com",
  payTo: "0xd441D9F4c59CB26253E2F0A7a62ac9cE7823b4b4", // Blockscout's Base address, as in its 402
  network: "eip155:8453",
  maxPerTx: 4_000n, // never more than 0.004 USDC per call
  pricePin: 2_000n, // 0.002 USDC, the published price
  label: "Blockscout",
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
const plan = pay.commitPlan([{ origin: "https://api.blockscout.com", maxSpend: 100_000n }], 60 * 60_000);

const res = await pay.fetch("https://api.blockscout.com/8453/api/v2/tokens/0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", { method: "GET" }, { plan });
console.log(res.status, res.payment?.settlement.transaction);
```

A 402 that asks for a different payee, a higher price or a different network is refused before anything is signed. Requires `@deepfirstsearch/agent-pay` 0.5.3 or later.

## 3. Or through MCP (Claude, Cursor, OpenClaw)

Add to the merchants of your [agent-pay-mcp](https://github.com/DeepFirstHQ/deepfirstsearch/tree/main/integrations/mcp) config, then ask the agent to use `https://api.blockscout.com/8453/api/v2/tokens/0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`:

```json
{ "origin": "https://api.blockscout.com", "label": "Blockscout", "payTo": "0xd441D9F4c59CB26253E2F0A7a62ac9cE7823b4b4",
  "price": "0.002", "maxPerTx": "0.004", "maxSpend": "1.00" }
```

> Agent Safe is an independent open-source project (MIT), live on Base mainnet as an unaudited beta. Not affiliated with Blockscout.
