# @deepfirstsearch/agent-pay

x402 v2 payments for AI agents where **the model proposes and the owner's policy decides**.

```bash
npm install @deepfirstsearch/agent-pay
```

> **Beta, unaudited.** Agent Safe is live on Base Sepolia and in a capped mainnet beta; an independent audit is being arranged. Use small amounts and at your own risk.

```ts
import { createAgentPay, MerchantRegistry, burnerPayers } from "@deepfirstsearch/agent-pay";

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
- x402 v1, malformed or oversized headers, and 402s reached through cross-origin redirects.
- Retrying a payment: one signature per request, recorded in a hash-chained audit log.

## Guards
- `commitPlan` (plan-then-execute)
- `taint` / `isTrusted` (provenance)
- `quarantinedExtract` (dual LLM with schema validation)
- `spotlight` (datamarking)
- `requiresHumanForEveryPayment` (Rule of Two)
- `RateLimiter`, `KillSwitch`
- `AuditLog` / `verifyChain`

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

Never reuse these keys on mainnet, and keep `BURNER_SEED` with the owner, not in the agent.

### Deployments

| Network | BudgetVaultFactory | FeeJar | Status |
|---|---|---|---|
| Base Sepolia (84532) | `0xf245d3cb8700a804432ea50b253a923b4b32c0c7` | `0x4ae59cf9462d1601de4fc5aa4538d376e93a79f2` | v0.4, testnet |
| Base (8453) | `0xDe17e1B889efa4671852e0b268e100967A7a257E` | `0xa375245D25bdB557801Ad07A50c19b3442cA3Ae4` | v0.4, **unaudited beta**: small amounts only |

Full list and transactions: [docs/DEPLOYMENTS.md](https://github.com/DeepFirstHQ/deepfirstsearch/blob/main/docs/DEPLOYMENTS.md). Questions or bugs: open an issue; security reports go through [SECURITY.md](https://github.com/DeepFirstHQ/deepfirstsearch/blob/main/SECURITY.md).

## Signing a budget (owner side)

The owner, never the agent, signs one budget per merchant. The budget names the agent key, the merchant and the only payer address the vault may top up:

```ts
import { burnerAddress, signIntent } from "@deepfirstsearch/agent-pay";

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

Keep the owner key (and the burner seed) out of the agent process. A compromised agent key can then only pay the merchant or top up the signed payer, within the caps.

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
