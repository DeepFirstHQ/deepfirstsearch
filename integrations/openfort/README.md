# @deepfirstsearch/agent-pay-openfort

Use an [Openfort](https://www.openfort.io/docs/products/server) backend wallet as an Agent Safe payer: your agent pays x402 APIs in USDC, the key stays with Openfort, and every payment stays inside the owner's rules (allowlisted payee, pinned price, sealed plan, optional on-chain budget).

> Beta, unaudited. Not affiliated with Openfort.

```bash
npm install @deepfirstsearch/agent-pay-openfort @deepfirstsearch/agent-pay @openfort/openfort-node viem
```

```ts
import Openfort from "@openfort/openfort-node";
import { createAgentPay, MerchantRegistry } from "@deepfirstsearch/agent-pay";
import { openfortPayer } from "@deepfirstsearch/agent-pay-openfort";

const openfort = new Openfort(process.env.OPENFORT_SECRET_KEY!, { walletSecret: process.env.OPENFORT_WALLET_SECRET });
const payer = await openfortPayer({ openfort, id: process.env.OPENFORT_ACCOUNT_ID! }); // holds a little USDC on Base

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

- **Look up, never create:** `openfortPayer({ openfort, id })` or `openfortPayer({ openfort, address })` fetches an existing backend wallet with `openfort.accounts.evm.backend.get`. Create it once with `openfort.accounts.evm.backend.create()`.
- **What Openfort signs:** x402 payments are EIP-3009 authorizations (EIP-712 typed data). `openfortPayer` wraps the wallet's own `signTypedData` with viem's `toAccount`; the address is returned checksummed (Openfort sends it in lowercase). Verified live on Base mainnet: [this payment](https://basescan.org/tx/0xaea677ea05bcf160eafa51f6813332d7e893c17462a32eabcfdba7cab62d1818) to CoinStats was signed by an Openfort backend wallet with the snippet above, run verbatim.
- **Openfort's server-side policies can't see the payment:** `@openfort/openfort-node` 0.13.1 hashes the typed data locally and sends only the hash, and Openfort evaluates it as `signEvmHash`. We tested both cases on a backend wallet:
  - with a policy that accepts `signEvmTypedData` only for USDC's verifying contract, every payment was refused, USDC included;
  - with a policy that accepts `signEvmHash`, any typed data was signed.

  So the payee, price and asset checks that Agent Safe makes before signing are the only checks that see the payment's content. Use Openfort's policies for what they can see, such as turning a wallet off.
- **Only typed data:** `signTransaction` and `signMessage` throw, and there is no raw-hash `sign`. A compromised agent can't use this signer to send transactions or sign arbitrary hashes.
- **Attacks never reach Openfort:** a 402 with a different payee, a higher price or an unknown origin is refused before any signature is requested.
- **Keep the keys out of the model's process:** the API key and the wallet secret belong in the payment service, never where the model runs.
- Pair it with on-chain budgets (`vaultFunder` and the owner CLI in `@deepfirstsearch/agent-pay`) so a compromised machine still can't exceed what the owner signed.

## Develop

```bash
npm ci && npm test   # offline: the real Openfort client against a local stand-in for its backend-wallet API, signing with a local key
```
