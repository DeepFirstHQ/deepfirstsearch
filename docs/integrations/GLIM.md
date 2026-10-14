# Glim (Cascade) + Agent Safe: live web data for agents, inside a budget

Glim (surf.cascade.fyi, the API behind Cascade's x402-proxy) serves live Twitter, Reddit, GitHub and web data to agents over x402, paid per call in USDC on Base. Agent Safe adds the guardrail people need before leaving an agent running: payments go **only to Glim (Cascade)'s address, never above your per-call cap, never past the budget**, whatever the agent was told.

**Tested live on Base mainnet (2026-10-09):** an agent paid Glim (Cascade) 0.002 USDC for `GET /api/v1/web/fetch/https://x402.org` and got the extracted content of x402.org. [Transaction](https://basescan.org/tx/0xc5ecd5a8eb4a5983f4ea139802ab5004ed2f2322bcff22fa68dedebf7f8b8db2). The same 402 checked against a different payee was refused with zero signatures.

## 1. Add Glim (Cascade) as a merchant

```ts
import { createAgentPay, MerchantRegistry } from "@deepfirstsearch/agent-pay";

const registry = new MerchantRegistry([{
  origin: "https://surf.cascade.fyi",
  payTo: "0xC751344Ee09B5159160173F77D4a1169bCd386A1", // Glim (Cascade)'s Base address, as in its 402
  network: "eip155:8453",
  maxPerTx: 5_000n, // never more than 0.005 USDC per call
  pricePin: 2_000n, // 0.002 USDC, the published price
  label: "Glim (Cascade)",
}]);
```

## 2. Pay per call

```ts
import { usdcAuthorizationCheck } from "@deepfirstsearch/agent-pay";
import { createPublicClient, http } from "viem";
import { base } from "viem/chains";

const pay = createAgentPay({
  registry,
  policy: { allowedNetworks: ["eip155:8453"], periodBudget: { amount: 1_000_000n, periodMs: 86_400_000 } },
  payer: () => yourWallet, // any viem account: local key, Turnkey, Privy, CDP, KMS
  // Glim (Cascade)'s receipt is not in the standard x402 form, so the SDK confirms the payment with USDC on-chain:
  confirmAuthorization: usdcAuthorizationCheck({ "eip155:8453": createPublicClient({ chain: base, transport: http() }) }),
  session: { readsUntrustedInput: true, accessesSensitiveData: false, canPay: true },
});
const plan = pay.commitPlan([{ origin: "https://surf.cascade.fyi", maxSpend: 100_000n }], 60 * 60_000);

const res = await pay.fetch("https://surf.cascade.fyi/api/v1/web/fetch/https://x402.org", { method: "GET" }, { plan });
console.log(res.status, res.payment?.confirmedOnChain ? "confirmed on-chain" : res.payment?.settlement.transaction);
```

A 402 that asks for a different payee, a higher price or a different network is refused before anything is signed. Requires `@deepfirstsearch/agent-pay` 0.6.3 or later.

## 3. Or through MCP (Claude, Cursor, OpenClaw)

Add to the merchants of your [agent-pay-mcp](https://github.com/DeepFirstHQ/deepfirstsearch/tree/main/integrations/mcp) config, then ask the agent to use `https://surf.cascade.fyi/api/v1/web/fetch/https://x402.org`:

```json
{ "origin": "https://surf.cascade.fyi", "label": "Glim (Cascade)", "payTo": "0xC751344Ee09B5159160173F77D4a1169bCd386A1",
  "price": "0.002", "maxPerTx": "0.005", "maxSpend": "1.00" }
```

Glim sends no receipt; `confirmOnChain` (on by default) checks the authorization on-chain, so the paid response is returned instead of being resent. Before paying, the agent can call `check_price` on the same URL to see the price and payee it would pay (agent-pay-mcp 0.4.0 or later).

## If Glim (Cascade) changes its price or address

The pins are deliberate. The 402 is written by the server, and a 402 that suddenly names another address or a higher price is exactly what a redirected or hijacked payment looks like. So when Glim (Cascade) reprices or rotates its wallet, Agent Safe refuses and nothing is signed:
- a higher price gives `price_changed` (action `ask_owner`), or `over_cap` if it is also above your per-call cap;
- a different address gives `payee_mismatch` (action `report`).

Confirm the change through Glim (Cascade)'s own channels (its site, docs or announcement), then update `pricePin` or `payTo` in the registry, or `price` or `payTo` in the MCP config. To absorb small price changes without a prompt, allow a tolerance instead of removing the pin: `toleranceBps` in the registry (1000 = up to 10% over the pin) or `tolerancePct` in the MCP config.

> Agent Safe is an independent open-source project (MIT), live on Base mainnet as an unaudited beta. Not affiliated with Glim (Cascade).
