# @deepfirstsearch/agent-pay-privy

Use a [Privy](https://www.privy.io) server wallet as an Agent Safe payer: your agent pays x402 APIs in USDC, the key stays in Privy, and every payment stays inside the owner's rules (allowlisted payee, pinned price, sealed plan, optional on-chain budget).

> Beta, unaudited. Not affiliated with Privy.

```bash
npm install @deepfirstsearch/agent-pay-privy @deepfirstsearch/agent-pay @privy-io/node viem
```

```ts
import { PrivyClient } from "@privy-io/node";
import { createAgentPay, MerchantRegistry } from "@deepfirstsearch/agent-pay";
import { privyPayer } from "@deepfirstsearch/agent-pay-privy";

const privy = new PrivyClient({ appId: process.env.PRIVY_APP_ID!, appSecret: process.env.PRIVY_APP_SECRET! });
const payer = privyPayer({
  privy,
  walletId: process.env.PRIVY_WALLET_ID!, // a Privy server wallet holding a little USDC on Base
  address: process.env.PRIVY_WALLET_ADDRESS! as `0x${string}`,
});

const pay = createAgentPay({
  registry: new MerchantRegistry([{
    origin: "https://api.blockchain.info",
    payTo: "0x995ffeF6c39234F0bBc95cf0E84FE1B6e6e2d8e0", // Blockchain.com's Base address, as in its 402
    network: "eip155:8453",
    maxPerTx: 2_000n, // never more than 0.002 USDC per call
    pricePin: 1_000n, // 0.001 USDC, the published price
  }]),
  policy: { allowedNetworks: ["eip155:8453"], periodBudget: { amount: 100_000n, periodMs: 86_400_000 } },
  payer: () => payer,
  session: { readsUntrustedInput: true, accessesSensitiveData: false, canPay: true },
});
const plan = pay.commitPlan([{ origin: "https://api.blockchain.info", maxSpend: 10_000n }], 60 * 60_000);

const res = await pay.fetch("https://api.blockchain.info/explorer-gateway-kt/x402/btc/address", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ address: "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa" }),
}, { plan });
console.log(res.status, res.payment?.settlement.transaction);
```

- **What Privy signs:** x402 payments are EIP-3009 authorizations (EIP-712 typed data). `privyPayer` uses Privy's own viem adapter (`createViemAccount` from `@privy-io/node/viem`), whose `signTypedData` we verified recovers to the wallet address on Base mainnet.
- **Transactions are refused:** an x402 payer only signs payment authorizations, so `signTransaction` throws. A compromised agent can't use this account to send arbitrary transactions.
- **Attacks never reach Privy:** a 402 with a different payee, a higher price or an unknown origin is refused before any signature is requested.
- **Tighten it further in Privy:** attach a policy to the wallet that only allows `eth_signTypedData_v4` for USDC's `TransferWithAuthorization` on Base.
- Pair it with on-chain budgets (`vaultFunder` and the owner CLI in `@deepfirstsearch/agent-pay`) so a compromised machine still can't exceed what the owner signed.

## Develop

```bash
npm ci && npm test   # offline: Privy's real viem adapter, with its wallet API answered by a local key
```
