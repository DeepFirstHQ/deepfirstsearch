# Automaton Sovereign + Agent Safe: signed oracles and a pre-flight firewall for agents, inside a budget

Automaton Sovereign serves signed DeFi oracles, a pre-flight transaction firewall (revert simulation, honeypot scan, safe slippage) and other agent tools over x402, paid per call in USDC on Base. Agent Safe adds the guardrail people need before leaving an agent running: payments go **only to Automaton Sovereign's address, never above your per-call cap, never past the budget**, whatever the agent was told.

**Tested live on Base mainnet (2026-10-09):** an agent paid Automaton Sovereign 0.001 USDC for `GET /v2/oracle/base` and got the signed Base oracle (gas and prices). [Transaction](https://basescan.org/tx/0xc903db362535837672334e6154041e9a2c6bf52b1b7473a57ebe2b90c2e2a5d9). The same 402 checked against a different payee was refused with zero signatures.

**Verified on both ends.** Automaton Sovereign's maintainer re-checked our payments against the chain with their own `GET /v1/verify-payment` and confirmed them from the seller side ([coinbase/agentkit#1544](https://github.com/coinbase/agentkit/issues/1544)). Our three payments on 2026-10-09:

| route | amount | transaction |
| --- | --- | --- |
| `GET /v2/oracle/base` (live test) | 0.001 USDC | [0xc903db36…a5d9](https://basescan.org/tx/0xc903db362535837672334e6154041e9a2c6bf52b1b7473a57ebe2b90c2e2a5d9) |
| `POST /v2/firewall/simulate-tx` | 0.02 USDC | [0x3dcf66a2…f782](https://basescan.org/tx/0x3dcf66a2e8b4543a0e607f0093de7853a7eaa62c5cc740a3623664f42819f782) |
| `GET /v2/oracle/base` (this guide run verbatim from npm) | 0.001 USDC | [0x131611e2…aa26](https://basescan.org/tx/0x131611e26e5844a2dce5ebb69a68a3e842f4625776e591710a9d97812f59aa26) |

Their public counters at https://api.automaton-sovereign.workers.dev/stats, as read by the maintainer at 2026-10-09 14:27 UTC: `settledCalls` 22 (19 before our run), `settledByEndpoint` `/v2/oracle/base` 3 and `/v2/firewall/simulate-tx` 5, `rejected` 45 (one is our deliberate replay of an already-settled proof, answered `402 payment_invalid / nonce_already_used_locally` with no second transfer). These counters keep moving; read them live rather than trusting this snapshot.

On a paid 200 the seller's origin sends a standard `PAYMENT-RESPONSE` (with `network: "base"`, a v1 name, and an extra `settledAt`) together with `X-Payment-Settled` and `X-Payment-Tx`; per its maintainer, its edge worker sends only the vendor pair. agent-pay 0.8.5 reads the standard receipt (mapping `base` to `eip155:8453`); 0.8.3 and 0.8.4 fall back to `X-Payment-Settled` / `X-Payment-Tx`. A replayed proof is classified `settled_not_delivered` (report, never re-sign).

## 1. Add Automaton Sovereign as a merchant

```ts
import { createAgentPay, MerchantRegistry } from "@deepfirstsearch/agent-pay";

const registry = new MerchantRegistry([{
  origin: "https://api.automaton-sovereign.workers.dev",
  payTo: "0x71DEAc098914A009E3720524642A6bE6F65EE528", // Automaton Sovereign's Base address, as in its 402
  network: "eip155:8453",
  maxPerTx: 5_000n, // never more than 0.005 USDC per call
  pricePin: 1_000n, // 0.001 USDC, the published price
  label: "Automaton Sovereign",
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
const plan = pay.commitPlan([{ origin: "https://api.automaton-sovereign.workers.dev", maxSpend: 100_000n }], 60 * 60_000);

const res = await pay.fetch("https://api.automaton-sovereign.workers.dev/v2/oracle/base", { method: "GET" }, { plan });
console.log(res.status, res.payment?.settlement.transaction);
```

A 402 that asks for a different payee, a higher price or a different network is refused before anything is signed. Requires `@deepfirstsearch/agent-pay` 0.8.3 or later.

> Agent Safe is an independent open-source project (MIT), live on Base mainnet as an unaudited beta. Not affiliated with Automaton Sovereign.
