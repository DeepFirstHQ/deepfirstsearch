# Stock Trends + Agent Safe: market data for agents, capped per call

Stock Trends sells stock price and trend data to agents over x402, per call in USDC on Base. Agent Safe adds the guardrail people need before leaving an agent running: payments go **only to Stock Trends's address, never above your per-call cap, never past the budget**, whatever the agent was told.

**Tested live on Base mainnet (2026-10-07):** an agent paid Stock Trends 0.0025 USDC for `GET /v1/prices/latest?symbol_exchange=IBM-N` and got the latest IBM price record. [Transaction](https://basescan.org/tx/0x02624a8158385533563b0f9ce9aa44b4372048004cf4d3fb2653c13897f9d1b0). The same 402 checked against a different payee was refused with zero signatures.

## 1. Add Stock Trends as a merchant

```ts
import { createAgentPay, MerchantRegistry } from "@deepfirstsearch/agent-pay";

const registry = new MerchantRegistry([{
  origin: "https://api.stocktrends.com",
  payTo: "0xAEeb8EaBdC05532a26123045f99D208EB1cC00ab", // Stock Trends's Base address, as in its 402
  network: "eip155:8453",
  maxPerTx: 5_000n, // never more than 0.005 USDC per call
  pricePin: 2_500n, // 0.0025 USDC, the published price
  label: "Stock Trends",
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
const plan = pay.commitPlan([{ origin: "https://api.stocktrends.com", maxSpend: 100_000n }], 60 * 60_000);

const res = await pay.fetch("https://api.stocktrends.com/v1/prices/latest?symbol_exchange=IBM-N", { method: "GET" }, { plan });
console.log(res.status, res.payment?.settlement.transaction);
```

A 402 that asks for a different payee, a higher price or a different network is refused before anything is signed. Requires `@deepfirstsearch/agent-pay` 0.5.3 or later.

## 3. Or through MCP (Claude, Cursor, OpenClaw)

Add to the merchants of your [agent-pay-mcp](https://github.com/DeepFirstHQ/deepfirstsearch/tree/main/integrations/mcp) config, then ask the agent to use `https://api.stocktrends.com/v1/prices/latest?symbol_exchange=IBM-N`:

```json
{ "origin": "https://api.stocktrends.com", "label": "Stock Trends", "payTo": "0xAEeb8EaBdC05532a26123045f99D208EB1cC00ab",
  "price": "0.0025", "maxPerTx": "0.005", "maxSpend": "1.00" }
```

Source, issues and the full SDK: [github.com/DeepFirstHQ/deepfirstsearch](https://github.com/DeepFirstHQ/deepfirstsearch). Questions or a merchant you'd like covered: [Discussions](https://github.com/DeepFirstHQ/deepfirstsearch/discussions).

## If Stock Trends changes its price or address

The pins are deliberate. The 402 is written by the server, and a 402 that suddenly names another address or a higher price is exactly what a redirected or hijacked payment looks like. So when Stock Trends reprices or rotates its wallet, Agent Safe refuses and nothing is signed:
- a higher price gives `price_changed` (action `ask_owner`), or `over_cap` if it is also above your per-call cap;
- a different address gives `payee_mismatch` (action `report`).

Confirm the change through Stock Trends's own channels (its site, docs or announcement), then update `pricePin` or `payTo` in the registry, or `price` or `payTo` in the MCP config. To absorb small price changes without a prompt, allow a tolerance instead of removing the pin: `toleranceBps` in the registry (1000 = up to 10% over the pin) or `tolerancePct` in the MCP config.

> Agent Safe is an independent open-source project (MIT), live on Base mainnet as an unaudited beta. Not affiliated with Stock Trends.
