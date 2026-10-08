# @deepfirstsearch/agent-pay-turnkey

Use a key held in [Turnkey](https://www.turnkey.com) as an Agent Safe payer: your agent pays x402 APIs in USDC, the key never leaves Turnkey, and every payment stays inside the owner's rules (allowlisted payee, pinned price, sealed plan, on-chain budget).

> Beta, unaudited. Not affiliated with Turnkey.

```bash
npm install @deepfirstsearch/agent-pay-turnkey @deepfirstsearch/agent-pay @turnkey/sdk-server viem
```

```ts
import { Turnkey } from "@turnkey/sdk-server";
import { createAgentPay, MerchantRegistry } from "@deepfirstsearch/agent-pay";
import { turnkeyPayer } from "@deepfirstsearch/agent-pay-turnkey";

const turnkey = new Turnkey({ apiBaseUrl: "https://api.turnkey.com", apiPublicKey, apiPrivateKey, defaultOrganizationId });
const payer = turnkeyPayer({ client: turnkey.apiClient(), address: "0xYourTurnkeyWalletAddress" });

const pay = createAgentPay({
  registry: new MerchantRegistry([{ origin: "https://api.example.com", payTo: "0x…", network: "eip155:8453", maxPerTx: 50_000n, pricePin: 10_000n }]),
  policy: { allowedNetworks: ["eip155:8453"] },
  payer: () => payer,
  session: { readsUntrustedInput: true, accessesSensitiveData: false, canPay: true },
});
```

- **What Turnkey signs:** x402 uses EIP-3009 authorizations, which are EIP-712 typed data. `turnkeyPayer` hashes the typed data locally with viem and asks Turnkey to sign that exact digest (`signRawPayload`, `HASH_FUNCTION_NO_OP`). In our tests, `@turnkey/viem` 0.14.44's `signTypedData` recovered to a different address than the signing wallet, while signing the digest recovers correctly; it also makes the signed payload auditable.
- **Attacks never reach Turnkey:** a 402 with a different payee, a higher price or an unknown origin is refused before any signature is requested, so a prompt-injected agent can't even spend your signing quota on it.
- **Tighten it further in Turnkey:** give the agent its own Turnkey user (not a root user) with a policy that only allows `ACTIVITY_TYPE_SIGN_RAW_PAYLOAD` for this wallet.
- Pair it with on-chain budgets (`vaultFunder` and the owner CLI in `@deepfirstsearch/agent-pay`) so a compromised machine still can't exceed what the owner signed.

## Develop

```bash
npm ci && npm test   # offline tests; set TURNKEY_CREDS=/path/creds.json to also run against a real Turnkey organization
```
