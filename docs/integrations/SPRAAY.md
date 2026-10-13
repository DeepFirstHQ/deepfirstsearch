# Spraay + Agent Safe: AI gateway calls with a hard cap

Spraay's x402 gateway gives agents AI models and tools behind one endpoint, paid per call in USDC on Base. Agent Safe adds the guardrail people need before leaving an agent running: payments go **only to Spraay's address, never above your per-call cap, never past the budget**, whatever the agent was told.

**Tested live on Base mainnet (2026-10-07):** an agent paid Spraay 0.001 USDC for `GET /api/v1/models` and got the gateway's model list. [Transaction](https://basescan.org/tx/0x544c9d25291d9c8d47f873bf9f5769c757d5edb14408e09c6ccf5c8bdf058eba). The same 402 checked against a different payee was refused with zero signatures.

## 1. Add Spraay as a merchant

```ts
import { createAgentPay, MerchantRegistry } from "@deepfirstsearch/agent-pay";

const registry = new MerchantRegistry([{
  origin: "https://gateway.spraay.app",
  payTo: "0xAd62f03C7514bb8c51f1eA70C2b75C37404695c8", // Spraay's Base address, as in its 402
  network: "eip155:8453",
  maxPerTx: 2_000n, // never more than 0.002 USDC per call
  pricePin: 1_000n, // 0.001 USDC, the published price
  label: "Spraay",
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
const plan = pay.commitPlan([{ origin: "https://gateway.spraay.app", maxSpend: 100_000n }], 60 * 60_000);

const res = await pay.fetch("https://gateway.spraay.app/api/v1/models", { method: "GET" }, { plan });
console.log(res.status, res.payment?.settlement.transaction);
```

A 402 that asks for a different payee, a higher price or a different network is refused before anything is signed. Requires `@deepfirstsearch/agent-pay` 0.5.3 or later.

## 3. Or through MCP (Claude, Cursor, OpenClaw)

Add to the merchants of your [agent-pay-mcp](https://github.com/DeepFirstHQ/deepfirstsearch/tree/main/integrations/mcp) config, then ask the agent to use `https://gateway.spraay.app/api/v1/models`:

```json
{ "origin": "https://gateway.spraay.app", "label": "Spraay", "payTo": "0xAd62f03C7514bb8c51f1eA70C2b75C37404695c8",
  "price": "0.001", "maxPerTx": "0.002", "maxSpend": "1.00" }
```

Source, issues and the full SDK: [github.com/DeepFirstHQ/deepfirstsearch](https://github.com/DeepFirstHQ/deepfirstsearch). Questions or a merchant you'd like covered: [Discussions](https://github.com/DeepFirstHQ/deepfirstsearch/discussions).

## If Spraay changes its price or address

The pins are deliberate. The 402 is written by the server, and a 402 that suddenly names another address or a higher price is exactly what a redirected or hijacked payment looks like. So when Spraay reprices or rotates its wallet, Agent Safe refuses and nothing is signed:
- a higher price gives `price_changed` (action `ask_owner`), or `over_cap` if it is also above your per-call cap;
- a different address gives `payee_mismatch` (action `report`).

Confirm the change through Spraay's own channels (its site, docs or announcement), then update `pricePin` or `payTo` in the registry, or `price` or `payTo` in the MCP config. To absorb small price changes without a prompt, allow a tolerance instead of removing the pin: `toleranceBps` in the registry (1000 = up to 10% over the pin) or `tolerancePct` in the MCP config.

> Agent Safe is an independent open-source project (MIT), live on Base mainnet as an unaudited beta. Not affiliated with Spraay.
