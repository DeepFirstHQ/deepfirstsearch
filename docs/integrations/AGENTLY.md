# Agently Echo + Agent Safe: paying other agents, inside a budget

Agently is a marketplace where agents find other agents and pay them over x402 via A2A, in USDC on Base. Agent Safe adds the guardrail people need before leaving an agent running: payments go **only to Agently Echo's address, never above your per-call cap, never past the budget**, whatever the agent was told.

**Tested live on Base mainnet (2026-10-09):** an agent paid Agently Echo 0.001 USDC for `POST /agent` and got its message echoed back by Agently's Echo agent over A2A. [Transaction](https://basescan.org/tx/0x611ca072d424bdaedefc2994a6666f0073ad30e5b6f5f726d45ca7357643c4d0). The same 402 checked against a different payee was refused with zero signatures.

## 1. Add Agently Echo as a merchant

```ts
import { createAgentPay, MerchantRegistry } from "@deepfirstsearch/agent-pay";

const registry = new MerchantRegistry([{
  origin: "https://echo.agently.to",
  payTo: "0x0799872E07EA7a63c79357694504FE66EDfE4a0A", // Agently Echo's Base address, as in its 402
  network: "eip155:8453",
  maxPerTx: 3_000n, // never more than 0.003 USDC per call
  pricePin: 1_000n, // 0.001 USDC, the published price
  label: "Agently Echo",
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
const plan = pay.commitPlan([{ origin: "https://echo.agently.to", maxSpend: 100_000n }], 60 * 60_000);

const res = await pay.fetch("https://echo.agently.to/agent", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({"jsonrpc": "2.0", "id": "1", "method": "message/send", "params": {"message": {"kind": "message", "messageId": "agentsafe-1", "role": "user", "parts": [{"kind": "text", "text": "Echo this message: hello from Agent Safe"}]}}}),
}, { plan });
console.log(res.status, res.payment?.settlement.transaction);
```

A 402 that asks for a different payee, a higher price or a different network is refused before anything is signed. Requires `@deepfirstsearch/agent-pay` 0.5.3 or later.

## 3. Or through MCP (Claude, Cursor, OpenClaw)

Add to the merchants of your [agent-pay-mcp](https://github.com/DeepFirstHQ/deepfirstsearch/tree/main/integrations/mcp) config, then ask the agent to use `https://echo.agently.to/agent`:

```json
{ "origin": "https://echo.agently.to", "label": "Agently Echo", "payTo": "0x0799872E07EA7a63c79357694504FE66EDfE4a0A",
  "price": "0.001", "maxPerTx": "0.003", "maxSpend": "1.00" }
```

> Agent Safe is an independent open-source project (MIT), live on Base mainnet as an unaudited beta. Not affiliated with Agently Echo.
