# Interzoid + Agent Safe: data matching for agents, inside a budget

Interzoid serves data-quality APIs (organization, name and address matching) to agents over x402, paid per call in USDC on Base. Agent Safe adds the guardrail people need before leaving an agent running: payments go **only to Interzoid's address, never above your per-call cap, never past the budget**, whatever the agent was told.

**Tested live on Base mainnet (2026-10-08):** an agent paid Interzoid 0.01 USDC for `GET /getorgmatchscore?org1=General%20Electric&org2=GE%20Corp` and got a match score for "General Electric" vs "GE Corp". [Transaction](https://basescan.org/tx/0xd5a6c5bf54212cff7eca9417346b569cc8366e3cde688035bee9b2c9f762ed77). The same 402 checked against a different payee was refused with zero signatures.

## 1. Add Interzoid as a merchant

```ts
import { createAgentPay, MerchantRegistry } from "@deepfirstsearch/agent-pay";

const registry = new MerchantRegistry([{
  origin: "https://api.interzoid.com",
  payTo: "0xdCEca23FF8A7145e1b5B35427C9886CF21A67566", // Interzoid's Base address, as in its 402
  network: "eip155:8453",
  maxPerTx: 20_000n, // never more than 0.02 USDC per call
  pricePin: 10_000n, // 0.01 USDC, the published price
  label: "Interzoid",
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
const plan = pay.commitPlan([{ origin: "https://api.interzoid.com", maxSpend: 100_000n }], 60 * 60_000);

const res = await pay.fetch("https://api.interzoid.com/getorgmatchscore?org1=General%20Electric&org2=GE%20Corp", { method: "GET" }, { plan });
console.log(res.status, res.payment?.settlement.transaction);
```

A 402 that asks for a different payee, a higher price or a different network is refused before anything is signed. Requires `@deepfirstsearch/agent-pay` 0.6.3 or later.

## If Interzoid changes its price or address

The pins are deliberate. The 402 is written by the server, and a 402 that suddenly names another address or a higher price is exactly what a redirected or hijacked payment looks like. So when Interzoid reprices or rotates its wallet, Agent Safe refuses and nothing is signed:
- a higher price gives `price_changed` (action `ask_owner`), or `over_cap` if it is also above your per-call cap;
- a different address gives `payee_mismatch` (action `report`).

Confirm the change through Interzoid's own channels (its site, docs or announcement), then update `pricePin` or `payTo` in the registry, or `price` or `payTo` in the MCP config. To absorb small price changes without a prompt, allow a tolerance instead of removing the pin: `toleranceBps` in the registry (1000 = up to 10% over the pin) or `tolerancePct` in the MCP config.

> Agent Safe is an independent open-source project (MIT), live on Base mainnet as an unaudited beta. Not affiliated with Interzoid.
