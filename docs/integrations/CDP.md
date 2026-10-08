# Coinbase CDP + Agent Safe: agent payments signed by a CDP Server Wallet

Let an agent pay for APIs over x402 from a Coinbase CDP Server Wallet v2 account, inside limits the owner sets. The key stays in CDP; every payment is checked against the owner's merchant list, price and budget **before** CDP is asked to sign, so a prompt-injected agent can't redirect a payment or spend past the budget.

**Tested live on Base mainnet (2026-10-08):** a CDP Server Wallet account paid CoinStats 0.001 USDC through the SDK with exactly one CDP signature ([tx](https://basescan.org/tx/0xa76ac006c55969d4c551b77ca0cb939b24a11427b6c2d0230c0d9ba0c873b7f7)). The same real 402 checked against a different payee was refused with zero CDP signatures. The guide's code below was then run verbatim and paid again ([tx](https://basescan.org/tx/0x0630e2d93ed370918427df81f2c697593ce51e990c99c16d046bfc9228a003ee)).

## 1. Install

```bash
npm install @deepfirstsearch/agent-pay @deepfirstsearch/agent-pay-cdp @coinbase/cdp-sdk viem
```

## 2. Use your CDP account as the payer

Create a Secret API Key and a Wallet Secret in the [CDP Portal](https://portal.cdp.coinbase.com) and set `CDP_API_KEY_ID`, `CDP_API_KEY_SECRET` and `CDP_WALLET_SECRET`. Create the account once (`await cdp.evm.getOrCreateAccount({ name: "my-agent" })`), send it a little USDC on Base (no ETH needed: the facilitator pays gas), and set `CDP_ACCOUNT_NAME` if you named it something else. This pays a real x402 API (0.001 USDC):

```ts
import { CdpClient } from "@coinbase/cdp-sdk";
import { createAgentPay, MerchantRegistry } from "@deepfirstsearch/agent-pay";
import { cdpPayer } from "@deepfirstsearch/agent-pay-cdp";

const cdp = new CdpClient(); // reads CDP_API_KEY_ID, CDP_API_KEY_SECRET and CDP_WALLET_SECRET
const payer = await cdpPayer({ cdp, name: process.env.CDP_ACCOUNT_NAME ?? "my-agent" }); // holds a little USDC on Base

const pay = createAgentPay({
  registry: new MerchantRegistry([{
    origin: "https://x402.coinstats.app",
    payTo: "0xa2AD8183209E5d2F7f0d8F995f5601a0bb5100c7", // CoinStats' Base address, as in its 402
    network: "eip155:8453",
    maxPerTx: 2_000n, // never more than 0.002 USDC per call
    pricePin: 1_000n, // 0.001 USDC, the published price
  }]),
  policy: { allowedNetworks: ["eip155:8453"], periodBudget: { amount: 100_000n, periodMs: 86_400_000 } },
  payer: () => payer,
  session: { readsUntrustedInput: true, accessesSensitiveData: false, canPay: true },
});
const plan = pay.commitPlan([{ origin: "https://x402.coinstats.app", maxSpend: 10_000n }], 60 * 60_000);

const res = await pay.fetch("https://x402.coinstats.app/coins/bitcoin?currency=USD", {}, { plan });
console.log(res.status, res.payment?.settlement.transaction);
```

`cdpPayer` takes `{ cdp, name }` or `{ cdp, address }` and only looks the account up (`cdp.evm.getAccount`); it never creates one.

## 3. Lock it down in CDP

Agent Safe decides *whether* to pay; CDP can enforce *what the key may sign*. Attach an account policy that only allows `signEvmTypedData` with USDC on Base (`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`) as the verifying contract, and keep the API key and wallet secret in the payment service, never in the model's process.

## A note on EIP-712

x402 uses EIP-3009 authorizations (EIP-712 typed data). `cdpPayer` wraps the CDP account's own `signTypedData` with viem's `toAccount`, and we checked that its signatures recover to the account address. `signTransaction` and `signMessage` are disabled on purpose and there is no raw-hash `sign`: an x402 payer never needs them.

Source, issues and the full SDK: [github.com/DeepFirstHQ/deepfirstsearch](https://github.com/DeepFirstHQ/deepfirstsearch). Questions or a merchant you'd like covered: [Discussions](https://github.com/DeepFirstHQ/deepfirstsearch/discussions).

> Agent Safe is an independent open-source project (MIT), live on Base mainnet as an unaudited beta. Not affiliated with Coinbase.
