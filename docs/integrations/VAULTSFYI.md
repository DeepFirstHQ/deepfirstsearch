# vaults.fyi + Agent Safe: DeFi yield data for agents, inside a budget

vaults.fyi serves DeFi vault and yield data to agents over x402, paid per call in USDC on Base. Agent Safe adds the guardrail people need before leaving an agent running: payments go **only to vaults.fyi's address, never above your per-call cap, never past the budget**, whatever the agent was told.

**Tested live on Base mainnet (2026-10-08):** an agent paid vaults.fyi 0.002 USDC for `GET /v2/networks` and got the list of networks vaults.fyi covers. [Transaction](https://basescan.org/tx/0x4dfaf6f674f29619a232516c24576b7941c76d7d015f473d15e42c1b8b53fa61). The same 402 checked against a different payee was refused with zero signatures.

## 1. Add vaults.fyi as a merchant

```ts
import { createAgentPay, MerchantRegistry } from "@deepfirstsearch/agent-pay";

const registry = new MerchantRegistry([{
  origin: "https://api.vaults.fyi",
  payTo: "0x108BCd8a07C3fdfca3Aa500784A8573123a1029F", // vaults.fyi's Base address, as in its 402
  network: "eip155:8453",
  maxPerTx: 4_000n, // never more than 0.004 USDC per call
  pricePin: 2_000n, // 0.002 USDC, the published price
  label: "vaults.fyi",
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
const plan = pay.commitPlan([{ origin: "https://api.vaults.fyi", maxSpend: 100_000n }], 60 * 60_000);

const res = await pay.fetch("https://api.vaults.fyi/v2/networks", { method: "GET" }, { plan });
console.log(res.status, res.payment?.settlement.transaction);
```

A 402 that asks for a different payee, a higher price or a different network is refused before anything is signed. Requires `@deepfirstsearch/agent-pay` 0.5.3 or later.

## 3. Or through MCP (Claude, Cursor, OpenClaw)

Add to the merchants of your [agent-pay-mcp](https://github.com/DeepFirstHQ/deepfirstsearch/tree/main/integrations/mcp) config, then ask the agent to use `https://api.vaults.fyi/v2/networks`:

```json
{ "origin": "https://api.vaults.fyi", "label": "vaults.fyi", "payTo": "0x108BCd8a07C3fdfca3Aa500784A8573123a1029F",
  "price": "0.002", "maxPerTx": "0.004", "maxSpend": "1.00" }
```

> Agent Safe is an independent open-source project (MIT), live on Base mainnet as an unaudited beta. Not affiliated with vaults.fyi.
