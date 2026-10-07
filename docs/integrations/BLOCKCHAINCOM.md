# Blockchain.com + Agent Safe: Bitcoin explorer data for agents, capped

Blockchain.com's Explorer API answers agents' Bitcoin address and transaction queries over x402, for USDC on Base. Agent Safe adds the guardrail people need before leaving an agent running: payments go **only to Blockchain.com's address, never above your per-call cap, never past the budget**, whatever the agent was told.

**Tested live on Base mainnet (2026-10-07):** an agent paid Blockchain.com 0.001 USDC for `POST /explorer-gateway-kt/x402/btc/address` and got the address summary for the Bitcoin genesis address. [Transaction](https://basescan.org/tx/0x6169b0e731e0ea7cabe39105d6b6209d07781c306fccb34bccc2ec59d5147e5e). The same 402 checked against a different payee was refused with zero signatures.

## 1. Add Blockchain.com as a merchant

```ts
import { createAgentPay, MerchantRegistry } from "@deepfirstsearch/agent-pay";

const registry = new MerchantRegistry([{
  origin: "https://api.blockchain.info",
  payTo: "0x995ffeF6c39234F0bBc95cf0E84FE1B6e6e2d8e0", // Blockchain.com's Base address, as in its 402
  network: "eip155:8453",
  maxPerTx: 2_000n, // never more than 0.002 USDC per call
  pricePin: 1_000n, // 0.001 USDC, the published price
  label: "Blockchain.com",
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
const plan = pay.commitPlan([{ origin: "https://api.blockchain.info", maxSpend: 100_000n }], 60 * 60_000);

const res = await pay.fetch("https://api.blockchain.info/explorer-gateway-kt/x402/btc/address", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({"address": "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa"}),
}, { plan });
console.log(res.status, res.payment?.settlement.transaction);
```

A 402 that asks for a different payee, a higher price or a different network is refused before anything is signed. Requires `@deepfirstsearch/agent-pay` 0.5.3 or later.

## 3. Or through MCP (Claude, Cursor, OpenClaw)

Add to the merchants of your [agent-pay-mcp](https://github.com/DeepFirstHQ/deepfirstsearch/tree/main/integrations/mcp) config, then ask the agent to use `https://api.blockchain.info/explorer-gateway-kt/x402/btc/address`:

```json
{ "origin": "https://api.blockchain.info", "label": "Blockchain.com", "payTo": "0x995ffeF6c39234F0bBc95cf0E84FE1B6e6e2d8e0",
  "price": "0.001", "maxPerTx": "0.002", "maxSpend": "1.00" }
```

> Agent Safe is an independent open-source project (MIT), live on Base mainnet as an unaudited beta. Not affiliated with Blockchain.com.
