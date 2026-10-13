# Audit scope: Deep First Search Agent Safe

Everything a reviewer needs to start. **Commit to audit: the `audit-v1` tag.** Everything in this repository except `web/` and vendored `lib/` is in scope.

## What it is
Agent Safe lets an AI agent pay for things (x402, USDC on Base) without being able to overspend or pay the wrong party, even if the model is prompt-injected. It works at two layers.

**On-chain (contracts):**
- The owner signs EIP-712 "intents". Each one fixes the agent key, one counterparty, one payer ("burner") address, per-payment, per-window and per-payer caps, and an expiry.
- Intents activate only after a timelock. Restrictions (reduce, revoke, pause) take effect instantly.
- The agent key can spend inside an intent but can never widen it.
- A 0.1% fee per payment is split between a FeeJar (later burned through the Firepit) and an operations Safe.

**Off-chain (SDK and integrations):**
- Before anything is signed, a deterministic policy outside the model checks every 402 against the owner's registry: the payee pinned by origin, the price pin, per-payment caps, a sealed session plan and a budget.
- Payer adapters (Turnkey, Privy, Coinbase CDP, Openfort, AgentKit) only ever sign EIP-3009 payment authorizations for the pinned USDC.
- The MCP server and the agent-framework tools (Vercel AI SDK, LangChain, AgentKit) expose paying to a model without exposing the policy.

## Scope

### 1. Contracts (`contracts/`): Solidity 0.8.30, Foundry, OpenZeppelin v5.6.1, Base (8453), Circle USDC (FiatToken v2.2)

| Contract | nSLOC | Notes |
|---|---|---|
| `src/safe/BudgetVault.sol` | ~305 | Intents, timelock, spend windows, signed payer tranches, EIP-3009 sweep, non-blocking fees |
| `src/safe/BudgetVaultFactory.sol` | 33 | CREATE2, owner bound into the salt, idempotent `create`, no admin |
| `src/fees/FeeJar.sol` | ~78 | No owner, no withdraw. One-time releaser behind a public 14-day timelock, codehash pinned per proposal, EIP-7702 accounts refused |
| `src/interfaces/IEIP3009.sol` | 13 | |
| `src/token/DepthToken.sol` | 25 | Fixed supply minted once; ERC20, Burnable and Permit; no owner |
| `src/token/DepthVesting.sol` | 14 | OZ `VestingWallet` with ownership transfer and renounce disabled |
| `src/distribution/MerkleAirdrop.sol` | ~50 | Claim window `[START, DEADLINE]`, then a public burn of the rest |
| `src/distribution/RewardsPool.sol` | ~60 | Halving epochs |
| `src/fees/Firepit.sol` | 78 | Burn $DEPTH to claim the FeeJar: a descending auction that arms only once connected and after `START` |
| `src/interfaces/IBurnableToken.sol` | 6 | |
| `script/DeployAgentSafe.s.sol`, `script/DeployGenesis.s.sol` | ~105 | Deployment, allocation, address prediction and post-deploy checks |

**Priority:** the Agent Safe contracts (BudgetVault, Factory, FeeJar) are live in a small, capped mainnet beta. The token contracts are not deployed.

### 2. SDK (`sdk/`): TypeScript, `@deepfirstsearch/agent-pay`, viem 2, zod 4

| Area | Approx. SLOC | Notes |
|---|---|---|
| `src/x402/` | ~950 | Client (402 handling, signing, settlement, never re-signing an unconfirmed payment), codecs, schemas, x402 v1 normalization, `dryRun`, on-chain confirmation |
| `src/policy/` | ~270 | Policy engine, merchant registry, pinned USDC per network, sanctions screens |
| `src/guard/` | ~300 | Sealed plan, refusal codes, kill switch and rate limits, taint and quarantine helpers, hash-chained audit log |
| `src/wallet/` | ~310 | Burner derivation, vault funder, intent signing, funding service, stealth addresses |
| `src/cli/`, `src/cli.ts` | ~680 | `agent-pay owner` (vault and budget administration, signs and sends), `check`, `demo` |
| `src/contracts/` | ~1,700 | Generated ABIs and deployment addresses (data, not logic) |

### 3. Integrations (`integrations/`): each published separately on npm

| Package | SLOC | Role |
|---|---|---|
| `mcp` (`agent-pay-mcp`) | ~290 | MCP server: `paid_fetch`, `list_merchants`, `budget_status` |
| `turnkey`, `privy`, `cdp`, `openfort` | ~25 each | Payer adapters: hosted-key wallets that may only sign the pinned EIP-3009 authorization |
| `agentkit`, `ai-sdk`, `langchain` | ~60–100 | Paid-fetch tools for agent frameworks (AgentKit also as a payer) |
| `order-guard` | ~110 | The same policy idea for agentic checkout (preview, approve, submit) |
| `zodiac-roles` | ~160 | Unpublished proof of concept: a Zodiac Roles v2.1.1 role scoped to USDC transfers within an allowance |

### 4. CI and release (`.github/workflows/`, `scripts/pr-guard/`)
- **Publishing:** npm trusted publishing (OIDC) with provenance, from tags pushed by maintainers only.
- **Outside pull requests:** a guard that reads each pull request as data and never runs it (see [docs/REVIEWING.md](../REVIEWING.md)).

**Out of scope:**
- `web/` (static site);
- `contracts/lib/` (vendored OpenZeppelin, forge-std);
- `sdk/scripts/` (ops scripts).

## Build and test
```bash
git clone --recurse-submodules https://github.com/DeepFirstHQ/deepfirstsearch && cd deepfirstsearch && git checkout audit-v1

cd contracts
forge build && forge test               # 117 tests: unit, fuzz (1,000 runs), properties, invariants, regressions
BASE_FORK_RPC=https://mainnet.base.org forge test --mc BaseMainnetForkTest   # 5 tests against real USDC on Base
forge coverage --report summary         # 100% lines/statements/functions on every contract
uvx --from slither-analyzer slither . --config-file slither.config.json

cd ../sdk && npm ci --ignore-scripts && npm test   # includes an anvil end-to-end with the official x402 facilitator
cd ../integrations/mcp && npm ci --ignore-scripts && npm test   # same for each integration package
```
Note: `foundry.toml` turns `dynamic_test_linking` off on purpose. With it on, `new C(...)` in a test escapes `expectRevert`, and a test can pass after its first expected revert without running the rest.

## Deployed code vs audited code
- The Base mainnet beta (Factory `0xDe17…257E`, FeeJar `0xa375…3Ae4`) was built from `732ef44`, which is v0.4.
- `audit-v1` adds the pre-audit fixes listed in [PREAUDIT-2026-10.md](PREAUDIT-2026-10.md): fee-split rounding, EIP-7702 releaser refusal, the burner-less intent edge case, the airdrop start and the genesis checks.
- After the audit and its fix review, the Agent Safe contracts will be redeployed from the audited commit. The beta holds only the founder's own funds.

## Roles and trust
| Role | Holder on mainnet | Can | Cannot |
|---|---|---|---|
| Vault owner | User (EOA, EIP-7702 EOA, or a smart wallet via ERC-1271) | Sign intents (timelocked); reduce, revoke, pause and withdraw instantly | — |
| Agent | Session key held by the agent runtime | Spend inside an active intent: `pay` the counterparty, and `fundBurner` the signed payer only | Create or widen intents; fund any other address; withdraw |
| Burner payer | SDK-derived key per merchant, its address signed into the intent | Hold at most `trancheCap` from the vault; sign EIP-3009 payments | Receive more than `trancheCap` from the vault |
| FeeJar `INITIALIZER` | Multisig Safe | Propose the releaser once (a Firepit pointing at this jar); it takes effect after a public 14-day timelock | Withdraw; change the releaser once set |
| `OPS` | Multisig Safe | Receive its share of the fees | Anything else |
| Payment service (off-chain) | Owner's infrastructure | Holds the registry, plan and wallet credentials, and asks the wallet to sign only after the policy passes | — |
| Model / web content / sellers | Untrusted | Propose a payment; show a 402 | Change who is paid, how much, the asset, the network or the plan |

There are no upgradeable proxies and no admin keys on vaults or the factory.

## Known issues and design decisions (please don't report these as findings)

**Contracts:**
1. **Fixed windows:** up to 2× `maxPerPeriod` can move around a window boundary (C-06).
2. **Burner payments go anywhere:** the vault funds only the payer address signed in the intent, but funds already in it can pay anyone if the burner key is also stolen (that is, the agent process is compromised). The SDK binds burner payments to the merchant, and the loss is bounded by `trancheCap` per burner and `maxPerPeriod` per window (C-07, ADR-006).
3. **Releaser choice:** the FeeJar `INITIALIZER` picks which Firepit is connected, once, behind a 14-day public timelock. During it, anyone can check `DEPTH()` and `pendingCodehash` (C-04).
4. **Owner signatures:** ECDSA is tried first, then ERC-1271, so EIP-7702 EOAs keep working (C-08).
5. **Fee rounding:** fees under 1 unit (amounts below 1,000 atomic USDC) are 0. Fees are charged on top, so a window can move `maxPerPeriod × 1.001`. The jar/OPS split rounds in the jar's favour.
6. **The owner key can withdraw everything instantly.** The timelock protects against phished or blind-signed intents, not against a stolen owner key.
7. **Fee transfers never block payments:** a fee that can't be delivered (for example, to a blacklisted recipient) is recorded as owed and flushed later. `withdraw` can't take owed fees. A caller who limits gas so that the fee transfer fails only defers the fee; it is never lost.
8. **USDC-inherent:** a USDC pause, or a blacklisted vault or burner, freezes the affected funds.
9. **Reductions can be front-run:** a stolen agent key can spend within the current caps before an owner's `reduceIntent` or `setPaused` lands.
10. **Intent ids are fixed at proposal.** After `reduceIntent`, the stored intent no longer hashes to its id (V-I-4).
11. **Burner with code:** USDC's v2.2 signature check uses ERC-1271 when the signer has code, so a burner with an EIP-7702 delegation couldn't sign. The SDK only uses plain EOAs as burners.

**Token:**

12. The Firepit's descent starts when it is connected and armed, both permissionless after the timelock. The runbook is to propose only once liquidity exists (T-L-1).
13. **Acknowledged from earlier reviews:**
    - the RewardsPool pays as a lump sum;
    - DEPTH sitting in the jar goes to the claimer;
    - an empty `assets` list burns and doubles the threshold.

**SDK and integrations:** see the acknowledged items in [PREAUDIT-2026-10.md](PREAUDIT-2026-10.md). For example, the audit log is tamper-evident but not keyed or anchored, and hosted-wallet policy engines (Turnkey) can't see the typed data behind a raw-digest signature.

## Prior reviews
- Two internal passes in early October, with PoC tests. Summary in [docs/assessments/SECURITY.md](../assessments/SECURITY.md).
- A third pass across everything in scope, with every finding and its status, in [PREAUDIT-2026-10.md](PREAUDIT-2026-10.md).
- Regression tests: `contracts/test/unit/AuditFixes.t.sol` (incl. `PreAuditFixesTest`) and the SDK and integration test suites.

## Questions we most want answered
- Can an agent key, a malicious merchant or a third party move more than the owner signed: per transaction, per window, per tranche, or after a revoke or pause?
- Can intents be replayed or front-run across vaults, chains or nonces (EIP-712 domain, nonce bitmap, CREATE2 address squatting)?
- Is `sweepBurner` safe against front-running and griefing under real FiatToken v2.2 semantics, including blacklisted accounts?
- Does any USDC behaviour (blacklist, pause, upgrade) brick the owner's `withdraw`?
- Could the FeeJar ever release to anything other than the reviewed Firepit?
- SDK: is there any path where server-controlled data (402 headers or bodies, receipts, redirects) changes what is signed, or makes the SDK sign twice for one purchase?
- Payer adapters: can any of them be made to sign something other than the pinned USDC `TransferWithAuthorization`?
- MCP and tools: can a prompt-injected model reach secrets, internal networks or the policy itself?

## Contact
Nicolas Tursi · security@deepfirstsearch.com
