# OneSource + Agent Safe: blockchain data for agents, capped

OneSource serves blockchain data to agents over x402, paid per call in USDC on Base. Agent Safe adds the guardrail people need before leaving an agent running: payments go **only to OneSource's address, never above your per-call cap, never past the budget**, whatever the agent was told.

**Tested live on Base mainnet (2026-10-07):** an agent paid OneSource 0.001 USDC for `GET /api/chain/block-number?network=ethereum` and got the latest Ethereum block number. [Transaction](https://basescan.org/tx/0xea4a2f46abce6f4624a90db2ffc2da43705497e810fadde34ac123e77b9292c5). The same 402 checked against a different payee was refused with zero signatures.

## 1. Add OneSource as a merchant

```ts
import { createAgentPay, MerchantRegistry } from "@deepfirstsearch/agent-pay";

const registry = new MerchantRegistry([{
  origin: "https://api.onesource.io",
  payTo: "0x52E29e0d2Aa49bfBfC548C0A9F2196F4aa51f3ea", // OneSource's Base address, as in its 402
  network: "eip155:8453",
  maxPerTx: 2_000n, // never more than 0.002 USDC per call
  pricePin: 1_000n, // 0.001 USDC, the published price
  label: "OneSource",
}]);
```

## 2. Pay per call

```ts
const pay = createAgentPay({
  registry,
  policy: { allowedNetworks: ["eip155:8453"], periodBudget: { amount: 1_000_000n, periodMs: 86_400_000 }, timeoutBounds: { min: 10, max: 3600 } }, // OneSource asks for 60-minute authorizations
  payer: () => yourWallet, // any viem account: local key, Turnkey, Privy, CDP, KMS
  session: { readsUntrustedInput: true, accessesSensitiveData: false, canPay: true },
});
const plan = pay.commitPlan([{ origin: "https://api.onesource.io", maxSpend: 100_000n }], 60 * 60_000);

const res = await pay.fetch("https://api.onesource.io/api/chain/block-number?network=ethereum", { method: "GET" }, { plan });
console.log(res.status, res.payment?.settlement.transaction);
```

A 402 that asks for a different payee, a higher price or a different network is refused before anything is signed. Requires `@deepfirstsearch/agent-pay` 0.5.3 or later.

Source, issues and the full SDK: [github.com/DeepFirstHQ/deepfirstsearch](https://github.com/DeepFirstHQ/deepfirstsearch). Questions or a merchant you'd like covered: [Discussions](https://github.com/DeepFirstHQ/deepfirstsearch/discussions).

> Agent Safe is an independent open-source project (MIT), live on Base mainnet as an unaudited beta. Not affiliated with OneSource.
