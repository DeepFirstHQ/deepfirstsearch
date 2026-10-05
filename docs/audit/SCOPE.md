# Audit scope: Deep First Search Agent Safe

Everything a reviewer needs to quote and start. Commit to audit: the tag named in the engagement (`audit-v1`).

## What it is
Agent Safe lets an AI agent pay for things (x402, USDC on Base) without being able to overspend or pay the wrong party, even if the model is prompt-injected.
- The owner signs EIP-712 "intents": agent key, one counterparty, per-payment, per-window and per-payer caps, and an expiry.
- Intents activate only after a timelock. Restrictions (reduce, revoke, pause) are instant.
- The agent key can spend inside an intent and never widen it.
- A 0.1% fee per payment is split between a FeeJar (later burned through the Firepit) and an operations Safe.

## Scope
Solidity 0.8.30 · Foundry · OpenZeppelin v5.6.1 · target chain Base (8453) · token: Circle USDC (FiatToken v2.2).

**Priority 1: launch on Base mainnet (Agent Safe, no token):**

| Contract | nSLOC | Notes |
|---|---|---|
| `src/safe/BudgetVault.sol` | 250 | Intents, timelock, spend windows, payer tranches, EIP-3009 sweep, fees |
| `src/safe/BudgetVaultFactory.sol` | 31 | CREATE2, owner bound into the salt, no admin |
| `src/fees/FeeJar.sol` | 43 | No owner, no withdraw. One-time releaser, pinned by codehash |
| `src/interfaces/IEIP3009.sol` | 13 | |
| **Total** | **337** | |

**Priority 2: token generation (later, can be a separate engagement):**

| Contract | nSLOC | Notes |
|---|---|---|
| `src/token/DepthToken.sol` | 25 | Fixed supply minted once; ERC20 + Burnable + Permit; no owner |
| `src/token/DepthVesting.sol` | 14 | OZ `VestingWallet`, with ownership transfer and renounce disabled |
| `src/distribution/MerkleAirdrop.sol` | 44 | |
| `src/distribution/RewardsPool.sol` | 58 | Halving epochs |
| `src/fees/Firepit.sol` | 62 | Burn $DEPTH to claim the FeeJar. No immutables on purpose (constant codehash) |
| `src/interfaces/IBurnableToken.sol` | 6 | |
| `script/DeployGenesis.s.sol` | — | Allocation and address prediction |
| **Total** | **209** | |

**Out of scope:** `web/`, `lib/`. The TypeScript SDK (`sdk/`) is optional; see "Trust boundary".

## Build and test
```bash
git clone --recurse-submodules https://gitlab.com/ntursi/deepfirstsearch && cd deepfirstsearch/contracts
forge build && forge test                                   # 57 tests: unit, fuzz (1,000 runs), properties, invariants
BASE_FORK_RPC=https://mainnet.base.org forge test --mc BaseMainnetForkTest   # 5 tests against real USDC on Base
forge coverage --no-match-coverage "(test|script|lib)"      # 100% lines and functions; BudgetVault branches 94%
cd ../sdk && npm ci && npm test                             # 50 tests, incl. an anvil end-to-end with the official x402 facilitator
```

**Static analysis:** Slither 0.11 and Aderyn, with no high or medium findings open. The triage is in [docs/assessments/SECURITY.md](../assessments/SECURITY.md).

## Roles and trust
| Role | Holder on mainnet | Can | Cannot |
|---|---|---|---|
| Vault owner | User (EOA, EIP-7702 EOA or smart wallet via ERC-1271) | Sign intents (timelocked); reduce, revoke, pause and withdraw instantly | — |
| Agent | Session key held by the agent runtime | Spend inside an active intent (`pay`, `fundBurner`) | Create or widen intents; withdraw |
| Burner payer | SDK-derived key per merchant | Hold at most `trancheCap`; sign EIP-3009 payments | Receive more than `trancheCap` from the vault |
| FeeJar `INITIALIZER` | Multisig Safe | Set the releaser once, only to code matching `RELEASER_CODEHASH` | Withdraw; change the releaser |
| `OPS` | Multisig Safe | Receive 50% of the fees | Anything else |

There are no upgradeable proxies and no admin keys on vaults or the factory.

## Known issues and design decisions (please don't report these as findings)
1. **Fixed windows:** up to 2× `maxPerPeriod` can move around a window boundary (C-06).
2. **Burner payments go anywhere:** funds in a burner can pay anyone. The merchant binding is enforced by the SDK; the loss is bounded by `trancheCap` per burner and `maxPerPeriod` per window (C-07, ADR-006).
3. **Releaser choice:** the FeeJar `INITIALIZER` chooses which Firepit instance (and so which token) is connected. This is pinned by codehash and one-time (C-04).
4. **Owner signatures:** they are accepted via ECDSA first, then ERC-1271, so EIP-7702 EOAs keep working (C-08).
5. **Fees round down:** fees under 1 unit (amounts below 1,000 atomic USDC) are 0.

## Questions we most want answered
- Can an agent key, a malicious merchant or a third party move more than the owner signed: per tx, per window, per tranche, or after revoke or pause?
- Can intents be replayed or front-run across vaults, chains or nonces (EIP-712 domain, nonce bitmap, CREATE2 address squatting)?
- Is `sweepBurner` safe against front-running and griefing with real FiatToken v2.2 semantics, including blacklisted accounts?
- Does any USDC behaviour (blacklist, pause, upgrade) brick the owner's `withdraw`?
- Could the FeeJar ever release to anything other than the pinned Firepit?

## Contact
Nicolas Tursi · security@deepfirstsearch.com · threat model and prior internal review: [docs/assessments/SECURITY.md](../assessments/SECURITY.md)
