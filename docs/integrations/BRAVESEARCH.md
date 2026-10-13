# Brave Search + Agent Safe: web search for agents, inside a budget

Brave Search serves its independent web index to agents over x402, paid per query in USDC on Base. Agent Safe adds the guardrail people need before leaving an agent running: payments go **only to Brave Search's address, never above your per-call cap, never past the budget**, whatever the agent was told.

**Tested live on Base mainnet (2026-10-08):** an agent paid Brave Search 0.005 USDC for `GET /res/v1/web/search?q=brave%20browser&count=5` and got five live web results for "brave browser". [Transaction](https://basescan.org/tx/0xb51cbf33c4cdc544cbc641decf704b29edfc12b7fe495eab3401d1be8e94b53d). The same 402 checked against a different payee was refused with zero signatures.

## 1. Add Brave Search as a merchant

```ts
import { createAgentPay, MerchantRegistry } from "@deepfirstsearch/agent-pay";

const registry = new MerchantRegistry([{
  origin: "https://search.agent.s.brave.app",
  payTo: "0xbd9420A98a7Bd6B89765e5715e169481602D9c3d", // Brave Search's Base address, as in its 402
  network: "eip155:8453",
  maxPerTx: 10_000n, // never more than 0.01 USDC per call
  pricePin: 5_000n, // 0.005 USDC, the published price
  label: "Brave Search",
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
const plan = pay.commitPlan([{ origin: "https://search.agent.s.brave.app", maxSpend: 100_000n }], 60 * 60_000);

const res = await pay.fetch("https://search.agent.s.brave.app/res/v1/web/search?q=brave%20browser&count=5", { method: "GET" }, { plan });
console.log(res.status, res.payment?.settlement.transaction);
```

A 402 that asks for a different payee, a higher price or a different network is refused before anything is signed. Requires `@deepfirstsearch/agent-pay` 0.5.3 or later.

## 3. Or through MCP (Claude, Cursor, OpenClaw)

Add to the merchants of your [agent-pay-mcp](https://github.com/DeepFirstHQ/deepfirstsearch/tree/main/integrations/mcp) config, then ask the agent to use `https://search.agent.s.brave.app/res/v1/web/search?q=brave%20browser&count=5`:

```json
{ "origin": "https://search.agent.s.brave.app", "label": "Brave Search", "payTo": "0xbd9420A98a7Bd6B89765e5715e169481602D9c3d",
  "price": "0.005", "maxPerTx": "0.01", "maxSpend": "1.00" }
```

## If Brave Search changes its price or address

The pins are deliberate. The 402 is written by the server, and a 402 that suddenly names another address or a higher price is exactly what a redirected or hijacked payment looks like. So when Brave Search reprices or rotates its wallet, Agent Safe refuses and nothing is signed:
- a higher price gives `price_changed` (action `ask_owner`), or `over_cap` if it is also above your per-call cap;
- a different address gives `payee_mismatch` (action `report`).

Confirm the change through Brave Search's own channels (its site, docs or announcement), then update `pricePin` or `payTo` in the registry, or `price` or `payTo` in the MCP config. To absorb small price changes without a prompt, allow a tolerance instead of removing the pin: `toleranceBps` in the registry (1000 = up to 10% over the pin) or `tolerancePct` in the MCP config.

> Agent Safe is an independent open-source project (MIT), live on Base mainnet as an unaudited beta. Not affiliated with Brave Search.
