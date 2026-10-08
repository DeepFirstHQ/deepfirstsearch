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

> Agent Safe is an independent open-source project (MIT), live on Base mainnet as an unaudited beta. Not affiliated with Heurist Mesh.
