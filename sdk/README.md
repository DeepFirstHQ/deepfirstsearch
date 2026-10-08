# @deepfirstsearch/agent-pay

x402 payments for AI agents (v2, plus v1 for merchants you opt in) where **the model proposes and the owner's policy decides**.

```bash
npm install @deepfirstsearch/agent-pay viem
npx @deepfirstsearch/agent-pay demo   # 10-second offline tour: one honest payment, four attacks refused
```

> **Beta, unaudited.** Agent Safe is live on Base Sepolia and in a capped mainnet beta; an independent audit is being arranged. Use small amounts and at your own risk.

**Project setup.** The samples are ESM with top-level `await`: run `npm pkg set type=module` in your project (or name the file `.ts` and run it with `npx tsx file.ts`). Node 20 or later. Install `viem` next to the SDK whenever a sample imports it (pnpm doesn't hoist it for you).

```ts
import { hexToBytes, type Hex } from "viem";
import { createAgentPay, MerchantRegistry, burnerPayers } from "@deepfirstsearch/agent-pay";

const ownerSeed = hexToBytes(process.env.AGENT_PAY_BURNER_SEED as Hex); // 32 random bytes, never the owner key

const registry = new MerchantRegistry([
  { origin: "https://api.pricing-intel.io", payTo: "0x…", network: "eip155:8453", maxPerTx: 50_000n, pricePin: 10_000n },
]);

const pay = createAgentPay({
  registry,
  policy: { allowedNetworks: ["eip155:8453"], approvalThreshold: 1_000_000n, periodBudget: { amount: 20_000_000n, periodMs: 86_400_000 } },
  payer: burnerPayers(ownerSeed, vaultAddress),      // one payer address per merchant
  session: { readsUntrustedInput: true, accessesSensitiveData: false, canPay: true },
  approve: askHumanViaPasskey,                       // a channel the model cannot write to
  ensureFunded: topUpFromAgentSafe,                  // BudgetVault.fundBurner, bounded on-chain
});

// 1. Seal the plan BEFORE the agent reads anything untrusted.
const plan = pay.commitPlan([{ origin: "https://api.pricing-intel.io", maxSpend: 100_000n }], 10 * 60_000);

// 2. Use it like fetch. A 402 is paid only if every check passes.
const res = await pay.fetch("https://api.pricing-intel.io/v1/prices", {}, { plan });
```

## What it refuses
- A 402 whose `payTo`, asset, network, EIP-712 domain, scheme or timeout differ from owner configuration.
- Prices above the pinned price, the per-merchant cap, the sealed plan or the period budget.
- Merchants not in the registry; payees suggested by web content (tainted data).
- x402 v1 from any merchant whose registry entry does not set `x402Versions: [1, 2]` (see below), malformed or oversized headers, and 402s reached through cross-origin redirects.
- An authorization window above 300 s (`policy.timeoutBounds`), unless that merchant sets `maxTimeoutSeconds` (10 to 86400) in the registry.

The 402 is read from `PAYMENT-REQUIRED`, or from `X-PAYMENT-REQUIRED` when the standard header is absent.
- Retrying a payment: one signature per request, recorded in a hash-chained audit log.

## Refusal codes

A refusal throws `PaymentDeniedError`. Its `reasons` are human-readable and may be reworded; its `codes` (one per reason) are stable and machine-readable, `code` is the primary one, and `action` says what the agent should do. The same codes are recorded in the `payment.denied` audit event.

```ts
import { PaymentDeniedError } from "@deepfirstsearch/agent-pay";

try {
  await pay.fetch(url, {}, { plan });
} catch (e) {
  if (e instanceof PaymentDeniedError && e.action === "report") alertOwner(e.code, e.reasons); // possible redirection: never retry
}
```

| code | action | meaning |
| --- | --- | --- |
| `payee_mismatch` | report | the 402's `payTo` is not the merchant's registered address |
| `network_mismatch` | report | an allowed network, but not the merchant's |
| `asset_mismatch` | report | asset or EIP-712 domain is not the pinned USDC |
| `scheme_unsupported` | report | a scheme or transfer method the SDK does not sign |
| `sanctioned_payee` | report | the payee failed sanctions screening (or screening was unavailable) |
| `invalid_402` | report | malformed or oversized 402, no options, a non-positive amount, or a cross-origin redirect |
| `price_changed` | ask_owner | the price is above the owner's pin (plus tolerance) |
| `human_refused` | ask_owner | a human declined the approval (or no approval channel exists) |
| `policy_denied` | ask_owner | generic refusal (default when no specific code applies) |
| `unknown_merchant` | fix_config | the origin is not in the registry (or is not https) |
| `not_in_plan` | fix_config | the merchant is not in the sealed plan |
| `network_not_allowed` | fix_config | a network outside `allowedNetworks` (or an unmapped x402 v1 network) |
| `asset_not_pinned` | fix_config | no USDC pinned for the merchant's network |
| `timeout_out_of_bounds` | fix_config | `maxTimeoutSeconds` outside the accepted bounds |
| `version_not_allowed` | fix_config | an x402 version not enabled for that merchant |
| `over_cap` | ask_owner | above the merchant's `maxPerTx` |
| `plan_exhausted` | retry_later | not enough left in the sealed plan |
| `plan_expired` | retry_later | the sealed plan expired; seal a new one |
| `budget_exhausted` | retry_later | not enough left in the period budget |

Actions: `report` (possible redirection or tampering: don't retry, report it), `ask_owner` (only the owner can decide), `fix_config` (the owner's configuration does not allow it), `retry_later` (a limit was reached: retry later or ask for a bigger plan), and, for blocks only, `resend_same` (request the same resource again: the SDK resends the same signed authorization and never signs a new one). With several reasons, `code` is the most cautious one. `REFUSAL_CODES`, `RefusalCode` and `RefusalAction` are exported.

### Block codes

Kill switch, rate limits and settlement problems are not refusals: they throw `PaymentBlockedError`, which carries a `code` and an `action` too (`BLOCK_CODES`, `BlockCode`, `BlockAction` are exported).

| code | action | meaning |
| --- | --- | --- |
| `settlement_pending` | resend_same | no receipt confirmed the payment; it may still settle. Request the same resource again: the same authorization is resent, nothing new is signed. Never re-sign |
| `settled_not_delivered` | report | it was paid (found on-chain, or the merchant answered a resend with "already used", e.g. `402 payment_invalid / tx_already_used`) but the resource was not delivered: never pay again, report it |
| `settlement_unknown` | ask_owner | an earlier authorization for this resource expired unconfirmed and nothing can tell whether it executed (no `confirmAuthorization`, or the RPC failed): nothing new is signed, since that could pay twice. Enable `confirmAuthorization`, or call `pay.forgetUnsettled(url)` after checking yourself |
| `rate_limited` | retry_later | the payment rate limit was reached |
| `kill_switch` | ask_owner | payments are stopped by the owner's kill switch |
| `blocked` | ask_owner | generic block (default when no specific code applies) |

#### When a payment is unconfirmed

One signed authorization per resource, and never a second one while the first could still have paid:

1. While the authorization is valid, asking for the resource again resends **the same** proof (`settlement_pending` → `resend_same`). Resends are bounded by its validity window (the 402's `maxTimeoutSeconds`, capped by your timeout bounds).
2. Near or just past expiry (until 60 s after `validBefore`, to cover chain clock skew) nothing is sent or signed: `settlement_pending`.
3. After that, the chain decides (with `confirmAuthorization`): never used → a new authorization is signed; used → `settled_not_delivered`, and that resource is not paid again. Without an on-chain check: `settlement_unknown`, until the owner clears it with `pay.forgetUnsettled(url)`.

Merchants without a standard receipt can say how settlement went with `X-Payment-Settled` on a 2xx: `true` (settled) or `queued` (in flight). The SDK accepts the delivered resource once, without resending or calling the chain, and reports it as `res.payment.merchantSettled`. The mapping, shared with sellers that render it:

| seller says | buyer state |
| --- | --- |
| 402, no payment yet | challenge (unpaid) |
| 2xx + `X-Payment-Settled: queued` | delivered, settlement pending (`merchantSettled: "queued"`) |
| 2xx + `X-Payment-Settled: true` | delivered (`merchantSettled: "true"`) |
| refusal to a resend saying the proof was already used | `settled_not_delivered` (report, never re-sign) |

## x402 v1 merchants (opt-in per merchant)

Some live merchants still speak x402 v1 (Heurist Mesh, for example): the 402 comes as a JSON body, networks have short names (`"base"`), the price is `maxAmountRequired`, and the payment goes in `X-PAYMENT`. v1 is off by default and there is no global switch. Allow it for one merchant in its registry entry:

```ts
new MerchantRegistry([
  { origin: "https://mesh.heurist.xyz", payTo: "0xA112c9C8BF655c678c768B6fD42a1C6FbfeD7D60", network: "eip155:8453",
    maxPerTx: 5_000n, pricePin: 1_000n, x402Versions: [1, 2] },   // default [2]; [1] allows only v1
]);
```

- Without the opt-in, a v1 402 is refused with a reason that names `x402Versions`; nothing is signed.
- v1 network names map to CAIP-2 through a fixed table only: `base` → `eip155:8453`, `base-sepolia` → `eip155:84532`. Options on any other network (e.g. `solana`) are skipped; if none is left, the 402 is refused.
- After that mapping every check above applies unchanged: registered `payTo`, pinned USDC and EIP-712 domain (never taken from `extra`), price pin, `maxPerTx`, plan and period budgets, timeout bounds, `allowedNetworks`.
- The signed payment is sent as `X-PAYMENT` (`{ x402Version: 1, scheme: "exact", network: "base", payload: { signature, authorization } }`, base64 JSON), the receipt is read from `X-PAYMENT-RESPONSE` with the same checks as v2, and `res.payment.settlement.network` is reported as CAIP-2. One signature per payment; retries resend the same header; `confirmAuthorization` works the same.
- A merchant whose `payTo` changes on every request (Browserbase hands out a fresh deposit address per 402) cannot be paid with a pinned payee and stays refused ("payTo … is not the merchant's registered address").

## Guards
- `commitPlan` (plan-then-execute)
- `taint` / `isTrusted` (provenance)
- `quarantinedExtract` (dual LLM with schema validation)
- `spotlight` (datamarking)
- `requiresHumanForEveryPayment` (Rule of Two)
- `RateLimiter`, `KillSwitch`
- `AuditLog` / `verifyChain`
- `screen` (optional sanctions screening, fails closed): `screen: anyScreen(staticListScreen(list), oracleScreen(publicClient, oracle))`
- `confirmAuthorization` (optional on-chain confirmation when a receipt is unusable): `usdcAuthorizationCheck({ "eip155:8453": publicClient })`

## Test without a chain

`@deepfirstsearch/agent-pay/testing` exports the offline x402 merchant used by the demo and our own tests. Routes can be honest or hostile (`tamper` rewrites the 402), and it verifies the EIP-3009 signatures like a facilitator would:

```ts
import { startMockServer } from "@deepfirstsearch/agent-pay/testing";

const payTo = "0x1111111111111111111111111111111111111111";
const merchant = await startMockServer({
  "/data": { price: 10_000n, payTo, body: '{"ok":true}' },
  "/evil": { price: 10_000n, payTo, tamper: (r) => ({ ...r, payTo: "0x9999999999999999999999999999999999999999" }) },
});
// merchant.url, merchant.received (payloads it got), await merchant.close()
```

A route with `x402Version: 1` speaks x402 v1 instead (402 in the body, `X-PAYMENT`, `X-PAYMENT-RESPONSE`); its payloads land in `merchant.receivedV1`, and `tamperV1` rewrites the whole v1 402 body (to add a Solana option, say).

## Owner CLI: vault and budgets in three commands

```bash
export AGENT_PAY_BURNER_SEED=0x…   # the same 32-byte seed your agent's SDK uses for payer addresses
npx @deepfirstsearch/agent-pay owner create-vault --keystore ~/.foundry/keystores/owner
npx @deepfirstsearch/agent-pay owner fund   --vault 0x… --amount 5 --keystore ~/.foundry/keystores/owner
npx @deepfirstsearch/agent-pay owner budget --vault 0x… --merchant 0x… --agent 0x… \
    --per-tx 0.05 --per-day 0.50 --keystore ~/.foundry/keystores/owner
npx @deepfirstsearch/agent-pay owner status --vault 0x…
```

- `--network base-sepolia` (default) or `--network base`. On Base mainnet every transaction asks for confirmation and warns that this is an unaudited beta.
- The owner key comes from a Foundry/geth keystore (`--keystore`, password prompted) or `AGENT_PAY_OWNER_KEY`; never from arguments.
- `budget` derives the merchant's payer address from `AGENT_PAY_BURNER_SEED`, signs the budget, proposes it, and prints the `intentId` plus a ready-to-paste entry for the [MCP server](https://github.com/DeepFirstHQ/deepfirstsearch/tree/main/integrations/mcp) config.
- Also: `pause`, `unpause`, `revoke --intent`, `withdraw --amount`, `flush-fees`, and `--json` for scripts.

The official addresses and ABIs are exported too: `AGENT_SAFE.base.factory`, `BUDGET_VAULT_FULL_ABI`, `BUDGET_VAULT_FACTORY_ABI`, `FEE_JAR_ABI`.

## When a merchant's receipt is missing

Some merchants answer a paid request without a usable receipt (no transaction in `PAYMENT-RESPONSE`). The SDK then reports the payment as unconfirmed rather than guessing. To let the chain decide, pass `confirmAuthorization`: on that failure path only, it reads USDC's `authorizationState` for the exact authorization you signed.

```ts
import { createPublicClient, http } from "viem";
import { base } from "viem/chains";
import { createAgentPay, usdcAuthorizationCheck } from "@deepfirstsearch/agent-pay";

const pay = createAgentPay({
  // ...registry, policy, payer, session
  confirmAuthorization: usdcAuthorizationCheck({ "eip155:8453": createPublicClient({ chain: base, transport: http() }) }),
});
// res.payment.confirmedOnChain === true when the receipt was unusable but the authorization was used on-chain.
```

If the authorization was used but the merchant didn't deliver, you get a clear error and nothing is resent.

## Pay real x402 APIs on Base mainnet (2 cents, 1 minute)

`examples/real-merchants.ts` (in the repository; examples are not shipped in the npm package) pays three public x402 APIs (Blockchain.com, Spraay, CoinGecko) through the SDK, 0.012 USDC per run, then shows an injected 402 for 5 USDC being refused before anything is signed. The payer needs a few cents of USDC on Base and no ETH.

```bash
git clone https://github.com/DeepFirstHQ/deepfirstsearch && cd deepfirstsearch/sdk && npm ci
PAYER_KEY=0x… npx tsx examples/real-merchants.ts   # a throwaway key, never a wallet that matters
```

Thirty merchants, each tested with a real payment, have a step-by-step guide at [deepfirstsearch.com/developers](https://deepfirstsearch.com/developers.html).

## Try the whole loop on Base Sepolia (free, about 1 hour)

`examples/sepolia-live.ts` runs a real x402 payment end to end with your own testnet keys: it creates a vault, signs a budget, waits out the timelock, then an agent pays a local x402 endpoint and the public facilitator settles it on-chain.

1. Make two fresh **testnet-only** keys (owner and agent), e.g. `cast wallet new`, and any merchant address.
2. Fund the owner with Base Sepolia ETH (the [Coinbase CDP faucet](https://portal.cdp.coinbase.com/products/faucet)) and at least 0.2 test USDC ([Circle faucet](https://faucet.circle.com), Base Sepolia).
3. Run it:

```bash
git clone https://github.com/DeepFirstHQ/deepfirstsearch && cd deepfirstsearch/sdk && npm ci
export OWNER_PK=0x… AGENT_PK=0x… MERCHANT=0x… BURNER_SEED=0x$(openssl rand -hex 32) \
       FACTORY=0xf245d3cb8700a804432ea50b253a923b4b32c0c7 STATE_FILE=./sepolia-state.json
npx tsx examples/sepolia-live.ts setup   # vault + funding + signed budget; the agent gets gas from the owner
# wait for the 1 h timelock printed by setup
npx tsx examples/sepolia-live.ts pay     # prints the settlement transaction
```

Never reuse these keys on mainnet.

### Deployments

| Network | BudgetVaultFactory | FeeJar | Status |
|---|---|---|---|
| Base Sepolia (84532) | `0xf245d3cb8700a804432ea50b253a923b4b32c0c7` | `0x4ae59cf9462d1601de4fc5aa4538d376e93a79f2` | v0.4, testnet |
| Base (8453) | `0xDe17e1B889efa4671852e0b268e100967A7a257E` | `0xa375245D25bdB557801Ad07A50c19b3442cA3Ae4` | v0.4, **unaudited beta**: small amounts only |

Full list and transactions: [docs/DEPLOYMENTS.md](https://github.com/DeepFirstHQ/deepfirstsearch/blob/main/docs/DEPLOYMENTS.md). Questions or bugs: open an issue; security reports go through [SECURITY.md](https://github.com/DeepFirstHQ/deepfirstsearch/blob/main/SECURITY.md).

## Signing a budget (owner side)

The owner, never the agent, signs one budget per merchant. The budget names the agent key, the merchant and the only payer address the vault may top up:

```ts
import { hexToBytes, type Hex } from "viem";
import { burnerAddress, signIntent } from "@deepfirstsearch/agent-pay";

const ownerSeed = hexToBytes(process.env.AGENT_PAY_BURNER_SEED as Hex); // the same seed the agent's payment process uses

const intent = {
  agent: agentAddress,
  counterparty: merchant.payTo,
  burner: burnerAddress({ ownerSeed, vault, chainId: 8453, counterparty: merchant.payTo }),
  token: USDC,
  maxPerTx: 50_000n,          // 0.05 USDC
  maxPerPeriod: 500_000n,     // 0.50 USDC per day
  trancheCap: 100_000n,       // the payer never holds more than 0.10 USDC
  period: 86_400,
  validAfter: 0n,
  expiry: BigInt(Math.floor(Date.now() / 1000) + 30 * 86_400),
  nonce: BigInt(Date.now()),
};
const signature = await signIntent(owner, vault, 8453, intent);
// Anyone can relay it: vault.proposeIntent(intent, signature). It activates after the vault's timelock.
```

Who holds what:
- **Owner key:** only the owner (ideally a Safe or hardware wallet). It signs budgets and can pause, revoke and withdraw. Never on the agent's machine.
- **Agent key and burner seed:** the payment process that runs the SDK. Run it apart from the model (a separate process or service): the model only asks for a URL, and the SDK decides. The burner seed must be its own random secret, never the owner key.
- **If the payment process is compromised,** the loss is bounded: the agent key can only top up the signed payers within `maxPerTx`, `maxPerPeriod` and `trancheCap`, and each payer never holds more than `trancheCap`. Revoke the intent and rotate the seed (`epoch`).

## Funding payers from Agent Safe

`vaultFunder({ agent, publicClient, vault, usdc, intents, tranche, dataSuffix })` returns an `ensureFunded` hook that tops up each merchant's payer from the BudgetVault right before a payment. The vault enforces every limit on-chain, and each top-up counts as one transaction: keep `tranche` at or below both the intent's `trancheCap` and its `maxPerTx`, or `fundBurner` reverts with `OverPerTx`/`OverTranche`. `dataSuffix` appends your Base Builder Code (ERC-8021 attribution) to those transactions.

## Privacy level 1: exchange-funded payers

`createFundingService({ registry, payerFor, withdraw, limits })` runs in the **owner's** process and holds the exchange credentials. The agent uses `remoteFunder(url, token)` as its `ensureFunded` hook and can only ask "top up the payer for merchant X". The service derives the payer address itself and applies a per-top-up limit and a daily limit. On-chain, the public sees "exchange → fresh payer" instead of "your vault → fresh payer". The exchange and lawful authorities can still see it. You provide `withdraw(to, amount)` for your exchange's API.

## Operational notes
- Keep the agent machine's clock synced (NTP): facilitators check authorization validity windows against wall-clock time.

## Privacy, honestly
- Each merchant sees a different payer address.
- Vault → payer funding is public on-chain; exchange-funded payers (level 1) and a third-party compliant pool (level 2) are next.
- Facilitators see your IP and timing; use a proxy.
- ERC-5564 stealth helpers are included for payee-side privacy.

## Develop

```bash
npm ci
npm test        # includes an anvil end-to-end test when Foundry and ../contracts/out exist
npm run demo
npm run build
```
