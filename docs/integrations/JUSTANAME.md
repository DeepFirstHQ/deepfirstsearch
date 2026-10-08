# JustaName + Agent Safe: ENS resolution for agents, inside a budget

JustaName serves ENS resolution to agents over x402, paid per call in USDC on Base. Agent Safe adds the guardrail people need before leaving an agent running: payments go **only to JustaName's address, never above your per-call cap, never past the budget**, whatever the agent was told.

**Tested live on Base mainnet (2026-10-08):** an agent paid JustaName 0.005 USDC for `GET /ens/v2/reverse?address=0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045&coinType=60` and got vitalik.eth as the reverse record of 0xd8dA…6045. [Transaction](https://basescan.org/tx/0x65d8bf0610d0ac15262cfe23e1b1db07fd5fade95c241858fb986ae22e0e19f9). The same 402 checked against a different payee was refused with zero signatures.

## 1. Add JustaName as a merchant

```ts
import { createAgentPay, MerchantRegistry } from "@deepfirstsearch/agent-pay";

const registry = new MerchantRegistry([{
  origin: "https://api.justaname.id",
  payTo: "0xc529edd6d47c60923902514c7c0b3993ae42c2ec", // JustaName's Base address, as in its 402
  network: "eip155:8453",
  maxPerTx: 10_000n, // never more than 0.01 USDC per call
  pricePin: 5_000n, // 0.005 USDC, the published price
  label: "JustaName",
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
  // JustaName's receipt is not in the standard x402 form, so the SDK confirms the payment with USDC on-chain:
  confirmAuthorization: usdcAuthorizationCheck({ "eip155:8453": createPublicClient({ chain: base, transport: http() }) }),
  session: { readsUntrustedInput: true, accessesSensitiveData: false, canPay: true },
});
const plan = pay.commitPlan([{ origin: "https://api.justaname.id", maxSpend: 100_000n }], 60 * 60_000);

const res = await pay.fetch("https://api.justaname.id/ens/v2/reverse?address=0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045&coinType=60", { method: "GET" }, { plan });
console.log(res.status, res.payment?.confirmedOnChain ? "confirmed on-chain" : res.payment?.settlement.transaction);
```

A 402 that asks for a different payee, a higher price or a different network is refused before anything is signed. Requires `@deepfirstsearch/agent-pay` 0.6.3 or later.

> Agent Safe is an independent open-source project (MIT), live on Base mainnet as an unaudited beta. Not affiliated with JustaName.
