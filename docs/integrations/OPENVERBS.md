# OpenVerbs + Agent Safe: crypto prices for agents, inside a budget

OpenVerbs serves crypto prices to agents over x402, paid per call in USDC on Base. Agent Safe adds the guardrail people need before leaving an agent running: payments go **only to OpenVerbs's address, never above your per-call cap, never past the budget**, whatever the agent was told.

**Tested live on Base mainnet (2026-10-13):** an agent paid OpenVerbs 0.001 USDC for `POST /v1/price` and got the live Bitcoin price. [Transaction](https://basescan.org/tx/0x4fb0013de41d422732b5b46c49e2447c88fd670f0cea5a2b466cbdfc0d363edd). The same 402 checked against a different payee was refused with zero signatures.

## 1. Add OpenVerbs as a merchant

```ts
import { createAgentPay, MerchantRegistry } from "@deepfirstsearch/agent-pay";

const registry = new MerchantRegistry([{
  origin: "https://crypto.openverbs.com",
  payTo: "0xb3f4de103F34b99f0Da19B4F16D6B53a14C2194A", // OpenVerbs's Base address, as in its 402
  network: "eip155:8453",
  maxPerTx: 2_000n, // never more than 0.002 USDC per call
  pricePin: 1_000n, // 0.001 USDC, the published price
  label: "OpenVerbs",
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
const plan = pay.commitPlan([{ origin: "https://crypto.openverbs.com", maxSpend: 100_000n }], 60 * 60_000);

const res = await pay.fetch("https://crypto.openverbs.com/v1/price", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({"coins": ["coingecko:bitcoin"]}),
}, { plan });
console.log(res.status, res.payment?.settlement.transaction);
```

A 402 that asks for a different payee, a higher price or a different network is refused before anything is signed. Requires `@deepfirstsearch/agent-pay` 0.5.3 or later.

## 3. Or through MCP (Claude, Cursor, OpenClaw)

Add to the merchants of your [agent-pay-mcp](https://github.com/DeepFirstHQ/deepfirstsearch/tree/main/integrations/mcp) config, then ask the agent to use `https://crypto.openverbs.com/v1/price`:

```json
{ "origin": "https://crypto.openverbs.com", "label": "OpenVerbs", "payTo": "0xb3f4de103F34b99f0Da19B4F16D6B53a14C2194A",
  "price": "0.001", "maxPerTx": "0.002", "maxSpend": "1.00" }
```

## If OpenVerbs changes its price or address

The pins are deliberate. The 402 is written by the server, and a 402 that suddenly names another address or a higher price is exactly what a redirected or hijacked payment looks like. So when OpenVerbs reprices or rotates its wallet, Agent Safe refuses and nothing is signed:
- a higher price gives `price_changed` (action `ask_owner`), or `over_cap` if it is also above your per-call cap;
- a different address gives `payee_mismatch` (action `report`).

Confirm the change through OpenVerbs's own channels (its site, docs or announcement), then update `pricePin` or `payTo` in the registry, or `price` or `payTo` in the MCP config. To absorb small price changes without a prompt, allow a tolerance instead of removing the pin: `toleranceBps` in the registry (1000 = up to 10% over the pin) or `tolerancePct` in the MCP config.

> Agent Safe is an independent open-source project (MIT), live on Base mainnet as an unaudited beta. Not affiliated with OpenVerbs.
