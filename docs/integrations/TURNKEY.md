# Turnkey + Agent Safe: agent payments signed inside Turnkey

Keep the agent's key in Turnkey and still let it pay for APIs over x402, inside limits the owner sets. The key never leaves Turnkey; every payment is checked against the owner's merchant list, price and budget **before** Turnkey is asked to sign, so a prompt-injected agent can't even spend your signing quota on an attack.

**Tested live on Base mainnet (2026-10-07):** a Turnkey-held wallet paid Exa ([tx](https://basescan.org/tx/0xad35b9a0bb64f2c5d7c79c3fca12bc393cfbd35b4b610a8500c3028199ec7c24)) and BlockRun ([tx](https://basescan.org/tx/0x543a36346d246f15a6febb9a5b258848aa0dca85d5a254d19e835cd1af15c952)) through the SDK: exactly two Turnkey signatures, exactly 0.007 USDC spent.

## 1. Install

```bash
npm install @deepfirstsearch/agent-pay @deepfirstsearch/agent-pay-turnkey @turnkey/sdk-server
```

## 2. Use your Turnkey wallet as the payer

```ts
import { Turnkey } from "@turnkey/sdk-server";
import { createAgentPay, MerchantRegistry } from "@deepfirstsearch/agent-pay";
import { turnkeyPayer } from "@deepfirstsearch/agent-pay-turnkey";

const turnkey = new Turnkey({ apiBaseUrl: "https://api.turnkey.com", apiPublicKey, apiPrivateKey, defaultOrganizationId });
const payer = turnkeyPayer({ client: turnkey.apiClient(), address: "0xYourTurnkeyWallet" });

const pay = createAgentPay({
  registry: new MerchantRegistry([/* merchants, e.g. Exa or BlockRun */]),
  policy: { allowedNetworks: ["eip155:8453"] },
  payer: () => payer,
  session: { readsUntrustedInput: true, accessesSensitiveData: false, canPay: true },
});
```

## 3. Lock it down in Turnkey

Give the agent its own (non-root) Turnkey user and a policy that only allows `ACTIVITY_TYPE_SIGN_RAW_PAYLOAD` for this wallet. Agent Safe decides *whether* to pay; Turnkey enforces *what the key may sign*.

## A note on EIP-712

x402 uses EIP-3009 authorizations (EIP-712 typed data). `turnkeyPayer` hashes the typed data with viem and has Turnkey sign that exact digest. In our tests, `@turnkey/viem` 0.14.44's `signTypedData` recovered to a different address than the signing wallet, while signing the digest recovers correctly, and it makes the signed payload easy to audit.

> Agent Safe is an independent open-source project (MIT), live on Base mainnet as an unaudited beta. Not affiliated with Turnkey.
