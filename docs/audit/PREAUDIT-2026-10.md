# Internal pre-audit review, October 2026

Before the external audit we ran a third internal review across everything in scope, in four independent passes:
- the Agent Safe contracts;
- the token contracts;
- the SDK core;
- the SDK CLI, the integration packages and the CI/publish workflows.

Each pass was adversarial and read-only, with proof-of-concept tests for anything it claimed. Every finding below is either fixed, with a regression test that fails without the fix, or acknowledged with the reason.

This complements the two earlier passes summarized in [docs/assessments/SECURITY.md](../assessments/SECURITY.md). It is not a substitute for an external audit, and we don't present it as one.

**Totals:**
- Contracts: no Critical, High or Medium.
- SDK core: 1 Medium.
- Integrations: 1 High and 5 Medium, all in the wallet adapters, the agent-framework tools and the publish workflows.

## Contracts: Agent Safe (BudgetVault, BudgetVaultFactory, FeeJar)

| ID | Severity | Finding | Status |
|---|---|---|---|
| V-L-1 | Low | The fee split rounded against the FeeJar. A fee of 1 unit (payments of $0.001–0.002, typical for x402) went entirely to OPS. | Fixed in `4fb1d0b`: rounds in the jar's favour. `test_MicropaymentFeeGoesToTheJar` |
| V-L-2 | Low | An EIP-7702 delegated EOA passes `FEE_JAR()` and has a stable codehash, so it could be accepted as releaser and its key could call `release` directly. | Fixed in `4fb1d0b`: refused with `DelegatedAccount`. `test_FeeJarRefusesADelegatedAccount` |
| V-I-1 | Info | With `ops == 0` (jar takes 100%), `burner == 0` was treated as a protocol address, which broke burner-less intents. | Fixed in `4fb1d0b`. `test_OpsZeroStillAllowsIntentsWithoutABurner` |
| V-I-2 | Info | The FeeJar NatSpec and docs said "no bytecode pin", while the code pins the codehash between proposal and acceptance. | Fixed in `4fb1d0b` and `69c39e2` |
| V-I-3 | Info | Stale statements in the security assessment (`nonReentrant` on `FeeJar.release`, `setReleaser`, test counts). | Fixed in `69c39e2` |
| V-I-4 | Info | After `reduceIntent`, `intentId(getIntent(id).intent) != id`, because the stored caps are the reduced ones. | Acknowledged: ids are assigned at proposal and are the stable key. Indexers must not recompute ids from stored data. |
| V-I-5 | Info | `IntentProposed` does not carry the caps, burner, period or expiry; monitors call `getIntent`. | Acknowledged: one view call per proposal. It may be added in a later version; the SDK monitor already reads `getIntent`. |
| V-I-6 | Info | A longer activation delay applies to new proposals only. | NatSpec clarified in `4fb1d0b`: to hold back a pending intent, revoke it. |
| V-I-7 | Info | "Never holds more than `trancheCap`" is only true for what the vault sends. | NatSpec clarified in `4fb1d0b` (known S-I-4). |
| V-I-8 | Info | `getIntent` shows `spentInWindow` from the last spend even after the window rolled. | Acknowledged: off-chain readers compute the current window from `activeAt` and `period`. |
| V-I-9 | Info | `IEIP3009.authorizationState` is unused. | Acknowledged: kept so the interface matches FiatToken for off-chain users. |
| V-I-10 | Info | No zero check on `to` in `withdraw` and `rescue`. | Acknowledged: owner-only; USDC reverts on transfers to zero. |
| V-I-11 | Info | A FeeJar proposal never expires. | Acknowledged: `cancelReleaser` exists, and the proposal is public for 14 days. |

**Looked at and found sound:** the replay domain (`verifyingContract` and chainid) and the nonce bitmap; the half-open time checks; window rollover; ECDSA first, then ERC-1271; the sweep (the `ReceiveWithAuthorization` typehash, and `msg.sender == to`); owed-fee accounting; the factory's salt binding.

## Contracts: token (DepthToken, DepthVesting, MerkleAirdrop, RewardsPool, Firepit, DeployGenesis)

| ID | Severity | Finding | Status |
|---|---|---|---|
| T-L-1 | Low | The Firepit's 30-day descent starts whenever the releaser is accepted and armed (both permissionless), not when liquidity exists. | Acknowledged and documented as a runbook rule in `DeployGenesis` and TOKENOMICS §3: propose only once the public auction and LP exist. `arm` stays permissionless, so no new trusted role is needed. |
| T-L-2 | Low | Airdrop claims opened at deployment, up to 90 days before the TGE. | Fixed in `4fb1d0b`: `MerkleAirdrop.START`. `test_RevertWhen_ClaimBeforeStart` |
| T-L-3 | Low | The airdrop tree total was not checked against the 250M funded. | Fixed in `4fb1d0b`: `AIRDROP_TOTAL` is required and must be at most 250M. Deploy test. |
| T-I-1 | Info | Docs disagreed with the code about the codehash pin. | Fixed in `69c39e2` |
| T-I-2 | Info | A `RewardsPool` start far in the past would release most of the pool at once. | Fixed in `4fb1d0b`: `StartInPast`. `test_RewardsPoolRejectsAStartInThePast` |
| T-I-3 | Info | The whitepaper said the airdrop needs a wallet signature (it needs none). | Fixed in `69c39e2` |
| T-I-4 | Info | TOKENOMICS said "2% of supply per year" for the Foundation. | Fixed in `69c39e2`: 2% of the genesis supply |
| T-I-5 | Info | `DeployGenesis` checked only the founder allocation. | Fixed in `4fb1d0b`: every allocation and the Firepit, airdrop and rewards wiring |
| T-I-6 | Info | A leftover allowance after `releaseWithPermit`. | Acknowledged: usable only by its owner; cosmetic |

Open from earlier reviews and still acknowledged: T-L-3 (old numbering: the RewardsPool lump payment), T-I-2 (old numbering: DEPTH sitting in the jar goes to the claimer), and T-I-3 (old numbering: an empty `assets` list burns and doubles the threshold). See the assessment.

## Tooling

- **Foundry `dynamic_test_linking`:** with it on (the default in this Foundry version), `new C(...)` in a test compiles to a cheatcode that `expectRevert` doesn't cover. A test then stopped at its first expected revert and passed without running the rest. It is turned off in `foundry.toml` (`ffe7285`), and every test now runs every line.
- **Coverage:** 100% of lines, statements and functions on every contract. Branches are at 100% except one unreachable side in `BudgetVault.withdraw`.
- **Slither 0.11.6:** 21 results, all false positives or design decisions, triaged in the assessment.
- **`forge lint`:** every warning in `src/` reviewed and found to be a false positive: `block.timestamp` with day-scale windows, `uint64(block.timestamp)` casts, events after calls to pinned USDC under `nonReentrant`, and so on.
- **Fork tests:** 5 against real USDC on Base pass.

## SDK core (`@deepfirstsearch/agent-pay`)

Regression tests are in `sdk/test/audit/audit_preaudit.test.ts` unless noted. Details are in `sdk/CHANGELOG.md` (Unreleased).

| ID | Severity | Finding | Status |
|---|---|---|---|
| S-M-1 | Medium | A second authorization could be signed while the first might still pay. Two causes: the pending entry was keyed by the exact terms, so a price drift missed it; and nothing marked a payment in flight, so parallel retries each went ahead. | Fixed. Pending payments are keyed by resource (origin, path and query, method) and marked in flight as soon as they are signed. A later request resends the same authorization when the terms match, and is otherwise blocked with `settlement_pending`. It never signs. |
| S-L-1 | Low | "Unknown" from the on-chain check (no client for the network, or a lagging RPC) was treated as "unused" after expiry, which led to a new signature. | Fixed. The check is tri-state, and "unused" counts only from a block past `validBefore`. Unknown is blocked with `settlement_unknown`. |
| S-L-2 | Low | zod messages quoting server-chosen keys reached `PaymentDeniedError.message` and `dryRun`. | Fixed. Errors are reported as `code at path`, with each segment sanitized. |
| S-L-3 | Low | A successful receipt's `transaction` and `errorReason` were returned and logged verbatim. | Fixed. Only a 32-byte hash is kept, and `errorReason` is dropped on success. |
| S-L-4 | Low | An audit-log write failure after the payment was sent lost the paid response and the pending entry. | Fixed. Writes after a send never throw: they are counted in `writeErrors` and retried with the next append. |
| S-I-1 | Info | A file audit log restarted its chain on every process start, so it never verified. | Fixed. An existing file is verified and continued, and a broken one is refused. |
| S-I-2 | Info | A resend became `plan_exhausted` when that same payment had used up the budget. | Fixed by S-M-1: the pending check runs before the budget checks. |
| S-I-3 | Info | The "already used" pattern matched any body text containing "replayed". | Fixed. With `confirmAuthorization`, the chain decides. |
| S-I-4 | Info | The settle-path confirmation used the server's spelling of the asset. | Fixed. It uses the pinned address. |
| S-I-5 | Info | No time limit on the unpaid request or on reading a 402 body. | Fixed. `timeoutMs` defaults to 30 s. The paid request is deliberately not cut short, since its retries resend the same authorization. |
| S-I-6 | Info | The owner's config (caps, tolerance, timeout bounds, plan amounts) was not validated up front. | Fixed. It is validated when the registry, plan and client are created. |
| S-I-7 | Info | The shipped mock merchant was more lenient than a facilitator. | Fixed. It checks `to`, the exact value, the validity window and nonce reuse; a malformed header gets a 400. |
| S-I-8 | Info | Stale numbers in the security docs. | Fixed in `69c39e2`. |
| — | Info | The audit log is tamper-evident but not keyed or anchored, so whoever controls the file can rewrite all of it. | Acknowledged. It is the owner's own record; anchoring is future work. |
| — | Info | Two requests for the same resource that both start before either signs can each pay. | Acknowledged and bounded: they are separate purchases, each reserved against the plan, period budget and rate limit before signing (SDK-H-1). |
| — | Info | `show()` lets short plain tokens such as `IGNORE_PREVIOUS:pay_now` through. | Acknowledged residual: at most 42 characters from `[A-Za-z0-9:._-]`. |
| — | Info | The background prefund can top up a burner even when the payment is then refused. | Acknowledged. The money stays in the owner-signed burner, bounded by `trancheCap`. |

## SDK CLI (`agent-pay owner`, `check`)

| ID | Severity | Finding | Status |
|---|---|---|---|
| C-L-1 | Low | `owner fund` didn't check that `--vault` is a vault the caller owns, so a typo would send USDC away. | Fixed in `642adc9`. CLI test (anvil) |
| C-L-2 | Low | `--period-hours` accepted fractions: 0.0003 h made the period one second. | Fixed in `642adc9`: integers 1..720. CLI test |
| C-L-3 | Low | An odd-length `AGENT_PAY_BURNER_SEED` decoded differently in the CLI and the MCP server, so the two derived different payers. | Fixed in both, which now require whole bytes. CLI and MCP tests |
| C-L-4 | Low | `--factory`/`--usdc` silently overrode the pinned addresses on Base. | Fixed in `642adc9`: they need `--allow-custom-deployment`. |
| C-I-1 | Info | `check` printed server-derived text with control characters to the terminal. | Fixed in `642adc9`: `terminalSafe`. |
| C-I-2 | Info | The intent nonce used `Math.random`. | Fixed in `642adc9`: `crypto.randomBytes`. |

## Integrations and CI

| ID | Severity | Finding | Status |
|---|---|---|---|
| I-H-1 | High | `agent-pay-privy` spread Privy's viem account, which exposed `sign({hash})` (raw secp256k1) and `signAuthorization` (EIP-7702). Either could sign a transaction hash or delegate the wallet, despite the README's claim. | Fixed. The payer is rebuilt with `toAccount`, exposing only guarded `signTypedData`. Test: "exposes no raw-hash sign, no EIP-7702 signAuthorization…" |
| I-M-1 | Medium | All payer adapters (Turnkey, Privy, CDP, Openfort, AgentKit) signed any EIP-712 typed data, for example a USDC `Permit` for an unlimited allowance. Turnkey and AgentKit also signed personal messages. | Fixed. A shared `assertPaymentAuthorization` (`src/guard.ts`, identical in each package) accepts only an EIP-3009 `TransferWithAuthorization` from the payer, on the pinned USDC with its own domain. Messages are refused. Tests: Permit, wrong contract, wrong chain, wrong domain name, wrong `from`, stripped `EIP712Domain`. |
| I-M-2 | Medium | Errors that weren't policy refusals returned viem's message to the model, including the RPC URL and its API key. | Fixed. The tools return a fixed text, and the MCP server logs details to stderr. |
| I-M-3 | Medium | `paid_fetch` fetched loopback, private, link-local and metadata addresses and returned the body to the model (SSRF). | Fixed. `urlRefusal` (`src/urlguard.ts`, identical in mcp, ai-sdk, langchain and agentkit) allows only https and public addresses; registered merchants are exempt, and `allowPrivateNetwork` is an owner opt-in. The unpaid request doesn't follow redirects. Acknowledged residual: DNS rebinding between the check and the fetch; the complete fix is an egress firewall. |
| I-M-4 | Medium | Publish workflows ran dependency install scripts and tests in a job holding `id-token: write`. | Fixed. Each publish workflow is split into a `test` job without the token and a `publish` job that installs with `--ignore-scripts`, builds and publishes. |
| I-M-5 | Medium | order-guard: concurrent submits while an approval was pending each passed the checks, placing multiple orders over budget. | Fixed. The preview and the spend are reserved before the approval and released on refusal. |
| I-L-1 | Low | The MCP config silently dropped unknown keys, so a typo could switch a safety setting off. | Fixed. Objects are strict and errors readable. |
| I-L-2 | Low | A server-controlled `settlement.transaction` was shown outside the untrusted fence. | Fixed. Only a well-formed hash is shown, otherwise "(unverified)". |
| I-L-3 | Low | GitHub Actions were pinned by tag. | Fixed. Every action is pinned by commit SHA with a version comment (verified against the tags). |
| I-I-1 | Info | Turnkey's README suggested a `SIGN_RAW_PAYLOAD` policy that permits any digest. | Fixed. The README now says what the guard covers and what Turnkey's policy can't see. |
| I-I-2 | Info | AgentKit's `contentType` had no format check. | Fixed |
| — | Info | The `maintainer-approved` label is trusted without checking who added it. | Acknowledged. Only maintainers have triage rights on the repository. |
