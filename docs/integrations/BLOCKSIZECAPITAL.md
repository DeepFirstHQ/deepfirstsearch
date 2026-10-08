# Blocksize Capital + Agent Safe: institutional prices for agents, inside a budget

Blocksize Capital serves institutional-grade crypto pricing to agents over x402, paid per call in USDC on Base. Agent Safe adds the guardrail people need before leaving an agent running: payments go **only to Blocksize Capital's address, never above your per-call cap, never past the budget**, whatever the agent was told.

**Tested live on Base mainnet (2026-10-08):** an agent paid Blocksize Capital 0.002 USDC for `GET /v1/bidask/BTC-USD` and got the live BTC-USD bid/ask. [Transaction](https://basescan.org/tx/0x8b4e2e39887a2c224bcdeed1bb8a9c8e4756fe5c724cd7e0ed544d1f7d36cf9b). The same 402 checked against a different payee was refused with zero signatures.

## 1. Add Blocksize Capital as a merchant

```ts
import { createAgentPay, MerchantRegistry } from "@deepfirstsearch/agent-pay";

const registry = new MerchantRegistry([{
  origin: "https://mcp.blocksize.info",
  payTo: "0x52C76F43aA871B407e242DCc396Ccc54a8C70aDe", // Blocksize Capital's Base address, as in its 402
  network: "eip155:8453",
  maxPerTx: 4_000n, // never more than 0.004 USDC per call
  pricePin: 2_000n, // 0.002 USDC, the published price
  label: "Blocksize Capital",
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
const plan = pay.commitPlan([{ origin: "https://mcp.blocksize.info", maxSpend: 100_000n }], 60 * 60_000);

const res = await pay.fetch("https://mcp.blocksize.info/v1/bidask/BTC-USD", { method: "GET" }, { plan });
console.log(res.status, res.payment?.settlement.transaction);
```

A 402 that asks for a different payee, a higher price or a different network is refused before anything is signed. Requires `@deepfirstsearch/agent-pay` 0.5.3 or later.

## 3. Or through MCP (Claude, Cursor, OpenClaw)

Add to the merchants of your [agent-pay-mcp](https://github.com/DeepFirstHQ/deepfirstsearch/tree/main/integrations/mcp) config, then ask the agent to use `https://mcp.blocksize.info/v1/bidask/BTC-USD`:

```json
{ "origin": "https://mcp.blocksize.info", "label": "Blocksize Capital", "payTo": "0x52C76F43aA871B407e242DCc396Ccc54a8C70aDe",
  "price": "0.002", "maxPerTx": "0.004", "maxSpend": "1.00" }
```

> Agent Safe is an independent open-source project (MIT), live on Base mainnet as an unaudited beta. Not affiliated with Blocksize Capital.
