# Audit scope: Deep First Search Agent Safe

Everything a reviewer needs to quote and start. Commit to audit: the tag named in the engagement (`audit-v1`).

## What it is
Agent Safe lets an AI agent pay for things (x402, USDC on Base) without being able to overspend or pay the wrong party, even if the model is prompt-injected.
- The owner signs EIP-712 "intents": agent key, one counterparty, one payer ("burner") address, per-payment, per-window and per-payer caps, and an expiry.
- Intents activate only after a timelock. Restrictions (reduce, revoke, pause) are instant.
- The agent key can spend inside an intent and never widen it.
- A 0.1% fee per payment is split between a FeeJar (later burned through the Firepit) and an operations Safe.

## Scope
Solidity 0.8.30 · Foundry · OpenZeppelin v5.6.1 · target chain Base (8453) · token: Circle USDC (FiatToken v2.2).

**Priority 1: launch on Base mainnet (Agent Safe, no token):**

| Contract | nSLOC | Notes |
|---|---|---|
| `src/safe/BudgetVault.sol` | 290 | Intents, timelock, spend windows, signed payer tranches, EIP-3009 sweep, non-blocking fees |
| `src/safe/BudgetVaultFactory.sol` | 33 | CREATE2, owner bound into the salt, idempotent `create`, no admin |
| `src/fees/FeeJar.sol` | 58 | No owner, no withdraw. One-time releaser behind a public 14-day timelock |
| `src/interfaces/IEIP3009.sol` | 13 | |
| **Total** | **394** | |

**Priority 2: token generation (later, can be a separate engagement):**

| Contract | nSLOC | Notes |
|---|---|---|
| `src/token/DepthToken.sol` | 25 | Fixed supply minted once; ERC20 + Burnable + Permit; no owner |
| `src/token/DepthVesting.sol` | 14 | OZ `VestingWallet`, with ownership transfer and renounce disabled |
| `src/distribution/MerkleAirdrop.sol` | 46 | Rejects a zero root or past deadline |
| `src/distribution/RewardsPool.sol` | 58 | Halving epochs |
| `src/fees/Firepit.sol` | 67 | Burn $DEPTH to claim the FeeJar; descending auction that opens at `START` from the ceiling |
| `src/interfaces/IBurnableToken.sol` | 6 | |
| `script/DeployGenesis.s.sol` | — | Allocation and address prediction |
| **Total** | **216** | |

**Out of scope:** `web/`, `lib/`. The TypeScript SDK (`sdk/`) is optional; see "Trust boundary".

## Build and test
```bash
git clone --recurse-submodules https://gitlab.com/ntursi/deepfirstsearch && cd deepfirstsearch/contracts
forge build && forge test                                   # 66 tests: unit, fuzz (1,000 runs), properties, invariants, regressions
BASE_FORK_RPC=https://mainnet.base.org forge test --mc BaseMainnetForkTest   # 5 tests against real USDC on Base
forge coverage --no-match-coverage "(test|script|lib)"      # 100% lines and functions; BudgetVault branches 94%
cd ../sdk && npm ci && npm test                             # 50 tests, incl. an anvil end-to-end with the official x402 facilitator
```

**Static analysis:** Slither 0.11 and Aderyn, with no high or medium findings open. The triage is in [docs/assessments/SECURITY.md](../assessments/SECURITY.md).

## Roles and trust
| Role | Holder on mainnet | Can | Cannot |
|---|---|---|---|
| Vault owner | User (EOA, EIP-7702 EOA or smart wallet via ERC-1271) | Sign intents (timelocked); reduce, revoke, pause and withdraw instantly | — |
| Agent | Session key held by the agent runtime | Spend inside an active intent: `pay` to the counterparty, `fundBurner` to the signed payer only | Create or widen intents; fund any other address; withdraw |
| Burner payer | SDK-derived key per merchant, address signed into the intent | Hold at most `trancheCap`; sign EIP-3009 payments | Receive more than `trancheCap` from the vault |
| FeeJar `INITIALIZER` | Multisig Safe | Propose the releaser (a Firepit pointing at this jar); it takes effect after a public 14-day timelock, once | Withdraw; change the releaser once set |
| `OPS` | Multisig Safe | Receive 50% of the fees | Anything else |

There are no upgradeable proxies and no admin keys on vaults or the factory.

## Known issues and design decisions (please don't report these as findings)
1. **Fixed windows:** up to 2× `maxPerPeriod` can move around a window boundary (C-06).
2. **Burner payments go anywhere:** the vault only funds the payer address signed in the intent, but funds already in it can pay anyone if the burner key is also stolen (agent process compromise). The SDK binds burner payments to the merchant; the loss is bounded by `trancheCap` per burner and `maxPerPeriod` per window (C-07, ADR-006).
3. **Releaser choice:** the FeeJar `INITIALIZER` chooses which Firepit instance (and so which token) is connected, once, with a 14-day public timelock during which anyone can check `DEPTH()` (C-04).
4. **Owner signatures:** they are accepted via ECDSA first, then ERC-1271, so EIP-7702 EOAs keep working (C-08).
5. **Fees round down:** fees under 1 unit (amounts below 1,000 atomic USDC) are 0. Fees are charged on top, so a window can move `maxPerPeriod × 1.001`.
6. **The owner key can withdraw everything instantly.** The timelock protects against phished or blind-signed intents, not against a stolen owner key.
7. **Fee transfers never block payments:** a fee that cannot be delivered (e.g. a blacklisted recipient) is recorded as owed and flushed later; `withdraw` cannot take owed fees.
8. **USDC-inherent:** a USDC pause, or a blacklisted vault or burner, freezes the affected funds.

An internal pre-audit (two independent passes, with PoC tests) found no High issues on the Agent Safe and 1 High on the token side; all Medium/High and most Low findings are fixed, with regression tests in `test/unit/AuditFixes.t.sol`, `test/unit/Firepit.t.sol` and `test/unit/BudgetVault.t.sol`. Summary in [docs/assessments/SECURITY.md](../assessments/SECURITY.md).

## Questions we most want answered
- Can an agent key, a malicious merchant or a third party move more than the owner signed: per tx, per window, per tranche, or after revoke or pause?
- Can intents be replayed or front-run across vaults, chains or nonces (EIP-712 domain, nonce bitmap, CREATE2 address squatting)?
- Is `sweepBurner` safe against front-running and griefing with real FiatToken v2.2 semantics, including blacklisted accounts?
- Does any USDC behaviour (blacklist, pause, upgrade) brick the owner's `withdraw`?
- Could the FeeJar ever release to anything other than the pinned Firepit?

## Contact
Nicolas Tursi · security@deepfirstsearch.com · threat model and prior internal review: [docs/assessments/SECURITY.md](../assessments/SECURITY.md)
