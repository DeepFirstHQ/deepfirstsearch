# Skavio + Agent Safe: web pages as Markdown for agents, inside a budget

Skavio serves bounded web fetch, search and extraction to agents over x402, paid per call in USDC on Base. Agent Safe adds the guardrail people need before leaving an agent running: payments go **only to Skavio's address, never above your per-call cap, never past the budget**, whatever the agent was told.

**Tested live on Base mainnet (2026-11-27):** an agent paid Skavio 0.01 USDC for `POST /x402/v1/web/fetch` and got x402.org as Markdown. [Transaction](https://basescan.org/tx/0x78deff570f1d557cadadc7f2b0f8bf91d462a77ea59cb180d90ced298d86e3b1). The same 402 checked against a different payee was refused with zero signatures.

## 1. Add Skavio as a merchant

```ts
import { createAgentPay, MerchantRegistry } from "@deepfirstsearch/agent-pay";

const registry = new MerchantRegistry([{
  origin: "https://getskavio.com",
  payTo: "0x62BB64E9Ab0E8104dEf0D7845223580319d4C139", // Skavio's Base address, as in its 402
  network: "eip155:8453",
  maxPerTx: 20_000n, // never more than 0.02 USDC per call
  pricePin: 10_000n, // 0.01 USDC, the published price
  label: "Skavio",
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
const plan = pay.commitPlan([{ origin: "https://getskavio.com", maxSpend: 100_000n }], 60 * 60_000);

const res = await pay.fetch("https://getskavio.com/x402/v1/web/fetch", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({"url": "https://x402.org", "output_format": "markdown"}),
}, { plan });
console.log(res.status, res.payment?.settlement.transaction);
```

A 402 that asks for a different payee, a higher price or a different network is refused before anything is signed. Requires `@deepfirstsearch/agent-pay` 0.5.3 or later.

## 3. Or through MCP (Claude, Cursor, OpenClaw)

Add to the merchants of your [agent-pay-mcp](https://github.com/DeepFirstHQ/deepfirstsearch/tree/main/integrations/mcp) config, then ask the agent to use `https://getskavio.com/x402/v1/web/fetch`:

```json
{ "origin": "https://getskavio.com", "label": "Skavio", "payTo": "0x62BB64E9Ab0E8104dEf0D7845223580319d4C139",
  "price": "0.01", "maxPerTx": "0.02", "maxSpend": "1.00" }
```

## If Skavio changes its price or address

The pins are deliberate. The 402 is written by the server, and a 402 that suddenly names another address or a higher price is exactly what a redirected or hijacked payment looks like. So when Skavio reprices or rotates its wallet, Agent Safe refuses and nothing is signed:
- a higher price gives `price_changed` (action `ask_owner`), or `over_cap` if it is also above your per-call cap;
- a different address gives `payee_mismatch` (action `report`).

Confirm the change through Skavio's own channels (its site, docs or announcement), then update `pricePin` or `payTo` in the registry, or `price` or `payTo` in the MCP config. To absorb small price changes without a prompt, allow a tolerance instead of removing the pin: `toleranceBps` in the registry (1000 = up to 10% over the pin) or `tolerancePct` in the MCP config.

> Agent Safe is an independent open-source project (MIT), live on Base mainnet as an unaudited beta. Not affiliated with Skavio.
