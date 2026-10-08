# @deepfirstsearch/agent-pay-cdp

Use a [Coinbase CDP](https://docs.cdp.coinbase.com/server-wallets/v2/introduction/welcome) Server Wallet v2 account as an Agent Safe payer: your agent pays x402 APIs in USDC, the key stays in CDP, and every payment stays inside the owner's rules (allowlisted payee, pinned price, sealed plan, optional on-chain budget).

> Beta, unaudited. Not affiliated with Coinbase.

```bash
npm install @deepfirstsearch/agent-pay-cdp @deepfirstsearch/agent-pay @coinbase/cdp-sdk viem
```

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

- **Look up, never create:** `cdpPayer({ cdp, name })` or `cdpPayer({ cdp, address })` fetches an existing account with `cdp.evm.getAccount`. Create it once with `cdp.evm.getOrCreateAccount({ name })`.
- **What CDP signs:** x402 payments are EIP-3009 authorizations (EIP-712 typed data). `cdpPayer` wraps the CDP account's own `signTypedData` with viem's `toAccount`; we verified its signatures recover to the account address on Base mainnet.
- **Only typed data:** `signTransaction` and `signMessage` throw and there is no raw-hash `sign`. A compromised agent can't use this signer to send transactions or sign arbitrary hashes.
- **Attacks never reach CDP:** a 402 with a different payee, a higher price or an unknown origin is refused before any signature is requested.
- **Tighten it further in CDP:** attach a policy to the account that only allows `signEvmTypedData` for USDC's `TransferWithAuthorization` on Base, and keep the API key and wallet secret in the payment service, never in the model's process.
- Pair it with on-chain budgets (`vaultFunder` and the owner CLI in `@deepfirstsearch/agent-pay`) so a compromised machine still can't exceed what the owner signed.

## Develop

```bash
npm ci && npm test   # offline: the real CdpClient against a local stand-in for CDP's Wallet API, signing with a local key
```
