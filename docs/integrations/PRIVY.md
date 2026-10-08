# Privy + Agent Safe: agent payments signed by a Privy server wallet

Let an agent pay for APIs over x402 from a Privy server wallet, inside limits the owner sets. The key stays in Privy; every payment is checked against the owner's merchant list, price and budget **before** Privy is asked to sign, so a prompt-injected agent can't redirect a payment or spend past the budget.

**Tested live on Base mainnet (2026-10-08):** a Privy server wallet paid Blockchain.com 0.001 USDC through the SDK with exactly one Privy signature ([tx](https://basescan.org/tx/0xd56426dda3386da27a86231c809d4ff1c5e59e285be675dfdd4eb7e8c3f2a2d9)). The same real 402 checked against a different payee was refused with zero Privy signatures.

## 1. Install

```bash
npm install @deepfirstsearch/agent-pay @deepfirstsearch/agent-pay-privy @privy-io/node viem
```

## 2. Use your Privy server wallet as the payer

Create a server wallet in your Privy app (dashboard or `POST /v1/wallets` with `chain_type: "ethereum"`), send it a little USDC on Base (no ETH needed: the facilitator pays gas), and set `PRIVY_APP_ID`, `PRIVY_APP_SECRET`, `PRIVY_WALLET_ID` and `PRIVY_WALLET_ADDRESS`. This pays a real x402 API (0.001 USDC):

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

## 3. Lock it down in Privy

Agent Safe decides *whether* to pay; Privy can enforce *what the key may sign*. Attach a wallet policy that only allows `eth_signTypedData_v4` for USDC's `TransferWithAuthorization` on Base, and keep the app secret in the payment service, never in the model's process.

## A note on EIP-712

x402 uses EIP-3009 authorizations (EIP-712 typed data). `privyPayer` uses Privy's own viem adapter (`createViemAccount`), and we checked that its `signTypedData` signatures recover to the wallet address. `signTransaction` is disabled on purpose: an x402 payer never needs to send transactions.

Source, issues and the full SDK: [github.com/DeepFirstHQ/deepfirstsearch](https://github.com/DeepFirstHQ/deepfirstsearch). Questions or a merchant you'd like covered: [Discussions](https://github.com/DeepFirstHQ/deepfirstsearch/discussions).

> Agent Safe is an independent open-source project (MIT), live on Base mainnet as an unaudited beta. Not affiliated with Privy.
