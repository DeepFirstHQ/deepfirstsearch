# Heurist Mesh + Agent Safe: paid crypto tools for agents, inside a budget

Heurist Mesh serves 30+ crypto research tools to agents over x402 (v1), paid per call in USDC on Base. Agent Safe adds the guardrail people need before leaving an agent running: payments go **only to Heurist Mesh's address, never above your per-call cap, never past the budget**, whatever the agent was told.

**Tested live on Base mainnet (2026-10-08):** an agent paid Heurist Mesh 0.001 USDC for `POST /x402/agents/AIXBTProjectInfoAgent/search_projects` and got live project data for "base" from the AIXBT project agent. [Transaction](https://basescan.org/tx/0x9c6d1e10302a7381b8871df999d6fff2ba78ddfedf0328ae72567c880875bf4f). The same 402 checked against a different payee was refused with zero signatures.

## 1. Add Heurist Mesh as a merchant

```ts
import { createAgentPay, MerchantRegistry } from "@deepfirstsearch/agent-pay";

const registry = new MerchantRegistry([{
  origin: "https://mesh.heurist.xyz",
  payTo: "0xA112c9C8BF655c678c768B6fD42a1C6FbfeD7D60", // Heurist Mesh's Base address, as in its 402
  network: "eip155:8453",
  maxPerTx: 5_000n, // never more than 0.005 USDC per call
  pricePin: 1_000n, // 0.001 USDC, the published price
  label: "Heurist Mesh",
  x402Versions: [1, 2], // Heurist Mesh speaks x402 v1; every check below still applies
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
const plan = pay.commitPlan([{ origin: "https://mesh.heurist.xyz", maxSpend: 100_000n }], 60 * 60_000);

const res = await pay.fetch("https://mesh.heurist.xyz/x402/agents/AIXBTProjectInfoAgent/search_projects", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({"name": "base"}),
}, { plan });
console.log(res.status, res.payment?.settlement.transaction);
```

A 402 that asks for a different payee, a higher price or a different network is refused before anything is signed. Requires `@deepfirstsearch/agent-pay` 0.7.0 or later.

## 3. Or through MCP (Claude, Cursor, OpenClaw)

Add to the merchants of your [agent-pay-mcp](https://github.com/DeepFirstHQ/deepfirstsearch/tree/main/integrations/mcp) config, then ask the agent to POST `{"name":"base"}` to `https://mesh.heurist.xyz/x402/agents/AIXBTProjectInfoAgent/search_projects`:

```json
{ "origin": "https://mesh.heurist.xyz", "label": "Heurist Mesh", "payTo": "0xA112c9C8BF655c678c768B6fD42a1C6FbfeD7D60",
  "price": "0.001", "maxPerTx": "0.005", "maxSpend": "1.00", "x402Versions": [1, 2] }
```

Heurist Mesh speaks x402 v1, which the MCP server accepts for this merchant only because `x402Versions` says so. Before paying, the agent can call `check_price` on the same URL to see the price and payee it would pay (agent-pay-mcp 0.4.0 or later).

## If Heurist Mesh changes its price or address

The pins are deliberate. The 402 is written by the server, and a 402 that suddenly names another address or a higher price is exactly what a redirected or hijacked payment looks like. So when Heurist Mesh reprices or rotates its wallet, Agent Safe refuses and nothing is signed:
- a higher price gives `price_changed` (action `ask_owner`), or `over_cap` if it is also above your per-call cap;
- a different address gives `payee_mismatch` (action `report`).

Confirm the change through Heurist Mesh's own channels (its site, docs or announcement), then update `pricePin` or `payTo` in the registry, or `price` or `payTo` in the MCP config. To absorb small price changes without a prompt, allow a tolerance instead of removing the pin: `toleranceBps` in the registry (1000 = up to 10% over the pin) or `tolerancePct` in the MCP config.

> Agent Safe is an independent open-source project (MIT), live on Base mainnet as an unaudited beta. Not affiliated with Heurist Mesh.
