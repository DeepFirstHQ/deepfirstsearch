# NetIntel + Agent Safe: clean web pages for agents, inside a budget

NetIntel turns any web page or PDF into clean Markdown for agents over x402, paid per call in USDC on Base. Agent Safe adds the guardrail people need before leaving an agent running: payments go **only to NetIntel's address, never above your per-call cap, never past the budget**, whatever the agent was told.

**Tested live on Base mainnet (2026-10-13):** an agent paid NetIntel 0.003 USDC for `GET /web/extract?url=https://www.sitemaps.org/protocol.html` and got the sitemaps.org protocol page as clean Markdown. [Transaction](https://basescan.org/tx/0x78cfc0416633b96819def07e7a4f47187a2c109ec7dd12b5a19a7ed28dd72809). The same 402 checked against a different payee was refused with zero signatures.

## 1. Add NetIntel as a merchant

```ts
import { createAgentPay, MerchantRegistry } from "@deepfirstsearch/agent-pay";

const registry = new MerchantRegistry([{
  origin: "https://netintel.dev",
  payTo: "0xdaDc335482AD545296Fd7b28518A251fFCbEb9Df", // NetIntel's Base address, as in its 402
  network: "eip155:8453",
  maxPerTx: 5_000n, // never more than 0.005 USDC per call
  pricePin: 3_000n, // 0.003 USDC, the published price
  label: "NetIntel",
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
const plan = pay.commitPlan([{ origin: "https://netintel.dev", maxSpend: 100_000n }], 60 * 60_000);

const res = await pay.fetch("https://netintel.dev/web/extract?url=https://www.sitemaps.org/protocol.html", { method: "GET" }, { plan });
console.log(res.status, res.payment?.settlement.transaction);
```

A 402 that asks for a different payee, a higher price or a different network is refused before anything is signed. Requires `@deepfirstsearch/agent-pay` 0.5.3 or later.

## 3. Or through MCP (Claude, Cursor, OpenClaw)

Add to the merchants of your [agent-pay-mcp](https://github.com/DeepFirstHQ/deepfirstsearch/tree/main/integrations/mcp) config, then ask the agent to use `https://netintel.dev/web/extract?url=https://www.sitemaps.org/protocol.html`:

```json
{ "origin": "https://netintel.dev", "label": "NetIntel", "payTo": "0xdaDc335482AD545296Fd7b28518A251fFCbEb9Df",
  "price": "0.003", "maxPerTx": "0.005", "maxSpend": "1.00" }
```

## If NetIntel changes its price or address

The pins are deliberate. The 402 is written by the server, and a 402 that suddenly names another address or a higher price is exactly what a redirected or hijacked payment looks like. So when NetIntel reprices or rotates its wallet, Agent Safe refuses and nothing is signed:
- a higher price gives `price_changed` (action `ask_owner`), or `over_cap` if it is also above your per-call cap;
- a different address gives `payee_mismatch` (action `report`).

Confirm the change through NetIntel's own channels (its site, docs or announcement), then update `pricePin` or `payTo` in the registry, or `price` or `payTo` in the MCP config. To absorb small price changes without a prompt, allow a tolerance instead of removing the pin: `toleranceBps` in the registry (1000 = up to 10% over the pin) or `tolerancePct` in the MCP config.

> Agent Safe is an independent open-source project (MIT), live on Base mainnet as an unaudited beta. Not affiliated with NetIntel.
