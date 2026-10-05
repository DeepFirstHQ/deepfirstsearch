# @deepfirstsearch/agent-pay

x402 v2 payments for AI agents where **the model proposes and the owner's policy decides**.

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

## Funding payers from Agent Safe

`vaultFunder({ agent, publicClient, vault, usdc, intents, tranche, dataSuffix })` returns an `ensureFunded` hook that tops up each merchant's payer from the BudgetVault right before a payment. The vault enforces every limit on-chain. `dataSuffix` appends your Base Builder Code (ERC-8021 attribution) to those transactions.

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
