# Zerion + Agent Safe: wallet data for agents, inside a budget

Zerion serves wallet portfolios, positions and transactions to agents over x402, paid per call in USDC on Base. Agent Safe adds the guardrail people need before leaving an agent running: payments go **only to Zerion's address, never above your per-call cap, never past the budget**, whatever the agent was told.

**Tested live on Base mainnet (2026-10-08):** an agent paid Zerion 0.01 USDC for `GET /v1/wallets/0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045/positions/` and got the live DeFi and token positions of vitalik.eth. [Transaction](https://basescan.org/tx/0xa084ada8d1647a786a65b70d4214f8fa676c32240d8dbfba7be735bf8307a923). The same 402 checked against a different payee was refused with zero signatures.

## 1. Add Zerion as a merchant

```ts
import { createAgentPay, MerchantRegistry } from "@deepfirstsearch/agent-pay";

const registry = new MerchantRegistry([{
  origin: "https://api.zerion.io",
  payTo: "0xD07C06a650a88bBCF4f0c4fbf2c6c08c9a60AcC6", // Zerion's Base address, as in its 402
  network: "eip155:8453",
  maxPerTx: 20_000n, // never more than 0.02 USDC per call
  pricePin: 10_000n, // 0.01 USDC, the published price
  label: "Zerion",
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
const plan = pay.commitPlan([{ origin: "https://api.zerion.io", maxSpend: 100_000n }], 60 * 60_000);

const res = await pay.fetch("https://api.zerion.io/v1/wallets/0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045/positions/", { method: "GET" }, { plan });
console.log(res.status, res.payment?.settlement.transaction);
```

A 402 that asks for a different payee, a higher price or a different network is refused before anything is signed. Requires `@deepfirstsearch/agent-pay` 0.5.3 or later.

## 3. Or through MCP (Claude, Cursor, OpenClaw)

Add to the merchants of your [agent-pay-mcp](https://github.com/DeepFirstHQ/deepfirstsearch/tree/main/integrations/mcp) config, then ask the agent to use `https://api.zerion.io/v1/wallets/0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045/positions/`:

```json
{ "origin": "https://api.zerion.io", "label": "Zerion", "payTo": "0xD07C06a650a88bBCF4f0c4fbf2c6c08c9a60AcC6",
  "price": "0.01", "maxPerTx": "0.02", "maxSpend": "1.00" }
```

> Agent Safe is an independent open-source project (MIT), live on Base mainnet as an unaudited beta. Not affiliated with Zerion.
