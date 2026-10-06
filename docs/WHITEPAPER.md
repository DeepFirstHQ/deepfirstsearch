# Deep First Search: Safe, Policy-Bound Payment Rails for AI Agents

**Whitepaper · Draft v0.2 · 5 October 2026**

> **Important notice.** This document describes open-source software and a token design. **No token exists, and this
> document is not an offer to sell, or a solicitation of an offer to buy, any crypto-asset or security in any
> jurisdiction.** It has not been reviewed or approved by any competent authority. If a token is ever offered to the
> public in the European Union, a separate crypto-asset white paper will be prepared in accordance with Regulation (EU)
> 2023/1114 (MiCA) and notified to a competent authority; this draft is structured to make that possible (see
> Appendix B). Forward-looking statements are plans, not commitments, and may change.

---

## Abstract

AI agents have begun to buy services autonomously using the x402 protocol, which settles stablecoin payments over plain HTTP. This creates two problems that existing tools do not address together:

- **Safety.** Agents routinely read untrusted content, can be manipulated through prompt injection, and hold keys that can move money.
- **Privacy.** Every x402 payment publishes the payer, payee, amount and timing on a public ledger.

Deep First Search provides:

1. **Agent Safe**, an on-chain vault in which the owner signs per-merchant budgets that an agent can spend but never widen.
2. An **x402 client** whose payment decision is made by deterministic code outside the language model.
3. **Exposure control:** per-merchant payer addresses, so merchants cannot match an agent's purchases by address, and (next) payers funded through a regulated exchange, so the public cannot trace them back to the owner.
4. Planned integration with a **third-party compliant privacy pool** (association sets, viewing keys).

The protocol charges a 0.1% fee in USDC. Half of it accrues to an immutable fee jar that can only be emptied by burning $DEPTH, a fixed-supply token with no minting function. The software is live on a local test network today; mainnet deployment follows an external audit, and no token will be issued before the protocol earns fees.

## 1. Introduction

### 1.1 Background
x402 revives the HTTP status code 402 *Payment Required*:
1. A server answers a request with payment requirements.
2. The client returns a signed stablecoin authorization (EIP-3009 for USDC).
3. A facilitator settles it.

The protocol is governed by the x402 Foundation under the Linux Foundation, whose members include Coinbase, Cloudflare, Google, Visa, Mastercard and Circle. Public analyses count tens of millions of x402 payments on Base and Solana, although the share driven by real autonomous agents is still small.

### 1.2 Problem statement
- **Prompt injection meets money.** Language models cannot reliably separate instructions from data. An agent that browses the web, reads documents or calls tools can be told to pay an attacker. Publicly reported incidents include agent-linked wallets drained through injected prompts.
- **Malicious payment requests.** In x402, the *server* tells the client whom to pay, in which asset, on which network and for how much. A compromised or malicious server can swap any of these fields.
- **Public ledgers leak strategy.** On-chain authorizations reveal `from`, `to`, `value` and time. Facilitators and servers also see IP addresses, request content and timing. For a business, an agent's payment history is its supplier list and research agenda.
- **Fragmented defenses.** Smart-account permission systems (session keys, spend permissions) bound *how much* can be spent but are not integrated with the x402 decision path. Existing privacy tools either hide only amounts or live on separate chains.

### 1.3 Design goals
1. **The model proposes; the owner's policy decides.** No output of a language model can create a payee, raise a budget or change a network.
2. **Bounded loss under full compromise.** Even if the agent and its keys are fully controlled by an attacker, losses are capped by limits the owner signed.
3. **Honest privacy.** Claim only what the system delivers, and say what still leaks.
4. **Non-custodial and immutable.** The project never holds user funds and has no administrative keys over deployed contracts.
5. **Token after product.** No token before the protocol earns fees; no inflation, ever.

## 2. System overview

```
 Owner (hardware key / Safe)
   │ signs EIP-712 Intents (per merchant, per period, timelocked)
   ▼
 BudgetVault (Base) ──fundBurner──▶ per-merchant payer address ──EIP-3009──▶ x402 facilitator ──▶ merchant
   │ 0.1% fee                         ▲
   ▼                                  │ signs only if the policy engine allows
 FeeJar ◀── Firepit (burn $DEPTH to claim)   SDK: policy engine · sealed plan · taint · audit log
```

| Component | Role | Status |
|---|---|---|
| `BudgetVault` / `BudgetVaultFactory` | Owner-signed, timelocked, per-merchant budgets; agent spend paths only | Implemented, tested |
| `@deepfirstsearch/agent-pay` | x402 v2 client; policy engine; injection guards; payer derivation; ERC-5564 | Implemented, tested |
| `FeeJar` + `Firepit` | Fee accumulation; burn-to-claim | Implemented, tested |
| `DepthToken`, `DepthVesting`, `MerkleAirdrop`, `RewardsPool` | Token and distribution | Implemented, tested |
| Compliant privacy pool (third party) | Payer unlinkability with association sets; integrated, not operated | Planned (Phase 2) |
| Private inference | Attested enclave models paid through the same rail | Planned (Phase 4) |

## 3. Agent Safe

### 3.1 Intents
The owner signs an EIP-712 `Intent` containing:
- the agent's session key;
- one counterparty;
- the token (USDC);
- `maxPerTx`, `maxPerPeriod` and `trancheCap`;
- the period length;
- validity bounds;
- a nonce.

The signature domain includes the chain ID and the vault address, so an intent cannot be replayed elsewhere. Anyone may relay a signed intent, and it activates only after a timelock of 1 hour to 7 days chosen by the owner. Shortening the timelock is itself delayed. Reducing limits, revoking an intent and pausing the vault take effect immediately, and the owner can always withdraw.

### 3.2 Spending paths
The agent key has exactly two capabilities:
- `pay(intent, to, amount)`, where `to` must equal the intent's counterparty;
- `fundBurner(intent, burner, amount)`, which tops up a payer address bound to that intent, never above `trancheCap`.

Both are subject to `maxPerTx` and to the period budget. Burner payer addresses sign ordinary EIP-3009 authorizations, so the system works with every x402 facilitator without changes.

### 3.3 Security properties (verified by tests)

| Property | How it is enforced |
|---|---|
| Spending per window never exceeds `maxPerPeriod` (plus the 0.1% fee, charged on top) | Invariant test with about 16,000 randomized calls |
| The agent can never modify an intent, the delay, the pause flag or the owner's funds | Unit and invariant tests |
| Loss on compromise of a payer key is at most `trancheCap` | Vault check on every top-up |
| Owner signatures cannot be replayed | Nonce bitmap and EIP-712 domain separation |

Known limitation: windows are fixed, so up to twice `maxPerPeriod` can move around a window boundary.

## 4. Payment policy and prompt-injection defenses

The SDK treats every 402 response as untrusted input and every model output as untrusted data.

1. **Owner registry.** Merchants are configured by the owner with origin, payee, network, per-payment cap and pinned price. The registry is the only source of payees.
2. **Pinned assets.** For each network, the USDC address and EIP-712 domain are fixed in code; the server's `extra` fields are never used to sign.
3. **Plan-then-execute.** Before reading untrusted content, the agent seals a plan listing merchants and budgets. Afterwards, nothing it reads can add a payee or raise a budget.
4. **Provenance tagging and quarantine.** Text extracted from untrusted sources by a tool-less model carries a taint label. Tainted values resolve to a merchant only by exact match with the registry.
5. **Rule of Two.** A session that combines untrusted input, sensitive data and the ability to pay requires human approval for every payment.
6. **Sanctions screening** of every payee before signing (static SDN list and/or an on-chain oracle; fails closed). Payments are never split to stay under reporting thresholds.
7. **Runtime controls:**
   - Rate limits per merchant and globally.
   - A kill switch.
   - No automatic retries; one idempotency key per signature.
   - A strict 8 KB, schema-validated header parser.
   - Refusal of 402 responses received through cross-origin redirects.
8. **Tamper-evident audit log.** Hash-chained records of every decision serve as the owner's evidence for audits and tax.

These controls follow published guidance:
- the CaMeL and *Design Patterns for Securing LLM Agents against Prompt Injections* (2025) line of work;
- Meta's Agents Rule of Two;
- OWASP LLM01:2025 and the OWASP Top 10 for Agentic Applications.

Spotlighting is included as defense in depth only.

## 5. Privacy model

| Observer | Learns today (v0.1) | After the shielded pool (Phase 2) |
|---|---|---|
| A merchant | Its own payer address, amounts, timing, the agent's IP unless proxied | Same, minus any link to the owner's other activity |
| Other merchants | Nothing that links them to each other by address | Same |
| A chain analyst | Vault → payer funding transactions, so payers can be linked to a vault | Funding broken by the pool; only deposits and withdrawals are visible |
| Facilitator | Payer, payee, amount, IP, timing | Same at the HTTP layer; use a proxy |

**Privacy levels, stated plainly.** Level 0 (today) is pseudonymity hygiene: merchants cannot cross-match, but a chain analyst can follow vault-to-payer funding. Level 1 (next) funds payers through a regulated exchange the owner already uses: the public, competitors and chain analysts lose the trail, while the exchange and lawful authorities keep it. The exchange credentials never reach the agent; an owner-side process sends bounded tranches. Level 2 (later) is a third-party compliant privacy pool.

Payee-side privacy uses ERC-5564 stealth addresses (scheme 1), implemented in the SDK. Phase 2 **integrates a third-party compliant privacy pool** (the candidate is Privacy Pools by 0xbow, with association sets, deposit screening and a ragequit exit) if one is deployed on Base. Deep First Search will **not deploy or operate** a pool: no pool interface, no relayers, no fees, and no link to the token.

## 6. Token: $DEPTH

### 6.1 Purpose
$DEPTH is the instrument through which protocol fees are retired. Anyone may claim the accumulated fees in the FeeJar by burning the current Firepit threshold of $DEPTH. The token confers:
- no ownership;
- no dividend, revenue share or redemption right;
- no claim on any entity or treasury.

Holding it entitles the holder to nothing beyond the ability to transfer or burn it.

### 6.2 Supply and allocation
1,000,000,000 tokens are minted once, in the token contract's constructor, directly into their allocation contracts. The contract has no owner and no mint function. Full terms are in the [Tokenomics](./TOKENOMICS.md).

| Allocation | Share | Mechanism |
|---|---:|---|
| Airdrop to real users | 25% | `MerkleAirdrop`, wallet-only claim; unclaimed tokens are burned |
| Fixed rewards pool | 25% | `RewardsPool`, halving releases over 8 years; remainder burned |
| Public fair auction | 15% | Single clearing price; restricted jurisdictions (US, Argentina, Ontario, sanctioned) excluded |
| Protocol-owned liquidity | 10% | Paired with auction proceeds; LP position burned |
| Founder | 12% | `DepthVesting`: nothing for 12 months, then 36 months linear; the vesting contract cannot be transferred |
| Contributors | 3% | Same schedule as the founder |
| Foundation | 10% | `DepthVesting` over 5 years (at most 2% of supply per year) |

### 6.3 Burn mechanism
- 50% of the 0.1% Agent Safe fee accrues in USDC to the FeeJar; the other 50% funds operations.
- The Firepit threshold doubles after each claim and halves every three days without one, bounded between 10,000 and 10,000,000 $DEPTH.
- No swap, oracle or administrator is involved. The auction opens at TGE from the ceiling.
- Only Agent Safe, SDK and inference fees may feed the jar.
- The burn mechanism activates only on a functioning network, and it is described as a protocol mechanism, never as a return.

## 7. Governance

There is no on-chain governance at launch. Deployed contracts are immutable and have no administrative functions. The only privileged addresses are:

| Address | What it can do | When |
|---|---|---|
| FeeJar `INITIALIZER` | Connect the Firepit, once | At genesis |
| RewardsPool `DISTRIBUTOR` | Pay vested rewards for work | Throughout the program |
| Vesting beneficiaries | Receive vested tokens | As they vest |

Each is a multi-signature Safe with hardware keys, and its address will be published.

## 8. Roadmap

| Phase | Milestone | Status |
|---|---|---|
| 0 | Research, legal and security assessments, contracts and SDK with tests | Done |
| 1 | Base Sepolia deployment (live, see DEPLOYMENTS.md); SDK on npm; Agent Safe web app; first users | Q4 2026 |
| 2 | External audit contest and bug bounty; Base mainnet; real USDC fees | Q1 2027 |
| 3 | Entity, legal and tax opinions; auction contract; airdrop snapshot | Q2 2027 |
| 4 | Token generation event: genesis, auction, claim, liquidity burn | Q3 2027, conditional on Phases 1–3 |
| 5 | Integration with a third-party compliant privacy pool; private inference | 2027–2028 |

## 9. Risk factors
Readers should consider, among others:
- Smart-contract defects and the immutability of deployed code.
- Manipulation of agents and the limits of policy enforcement. A registered merchant can still charge for something useless.
- Network-level and on-chain privacy leakage as described in Section 5.
- Dependence on Base, which has a single sequencer operated by Coinbase, and on USDC and x402 facilitators.
- Regulatory change affecting privacy software, crypto-assets or their listing: US securities and money-transmission law, EU MiCA and AMLR, Argentine CNV and tax rules.
- The possibility that the token is never issued, has no market, or loses all value.
- Small or zero fees, in which case little or nothing is burned.

A fuller list is published at `/legal/risks.html`.

## 10. Legal and regulatory considerations
- The project is designed to be non-custodial. It operates no relayer or mixing service and takes no fee from any privacy pool.
- Any public token sale will exclude persons in the United States, Argentina, Ontario and sanctioned jurisdictions. Whether a paid sale happens at all is still open (a no-sale launch is under consideration).
- EU participation will either stay within MiCA exemptions or be accompanied by a notified white paper.
- The airdrop requires only a wallet signature and no personal data.
- The detailed legal analysis is kept privately and will be reviewed by counsel before any token distribution. Nothing here is legal advice.

## References
1. x402 Foundation. *x402 Specification v2.* github.com/x402-foundation/x402
2. EIP-3009: Transfer With Authorization. EIP-712: Typed structured data hashing and signing. ERC-5564: Stealth Addresses. ERC-6538: Stealth Meta-Address Registry.
3. Debenedetti et al. *Defeating Prompt Injections by Design (CaMeL).* 2025.
4. Beurer-Kellner et al. *Design Patterns for Securing LLM Agents against Prompt Injections.* arXiv:2506.08837, 2025.
5. Meta. *Agents Rule of Two.* 2025. OWASP. *Top 10 for LLM Applications 2025; Top 10 for Agentic Applications 2026.*
6. Buterin et al. *Blockchain Privacy and Regulatory Compliance: Towards a Practical Equilibrium* (Privacy Pools). 2023.
7. Uniswap Labs. *UNIfication: protocol fee TokenJar and Firepit.* 2025.
8. Regulation (EU) 2023/1114 (MiCA), Title II and Annex I; Regulation (EU) 2024/1624 (AMLR), Art. 79.
9. Project research notes: `docs/research/01–05`.

## Appendix A: Deployed contract interfaces (summary)
- `BudgetVault`: `proposeIntent`, `reduceIntent`, `revokeIntent`, `invalidateNonce`, `setPaused`, `setActivationDelay`, `withdraw`, `rescue`, `pay`, `fundBurner` (only to the payer signed in the intent), `sweepBurner`, `flushFees`.
- `FeeJar`: `proposeReleaser` (initializer, once) → 14-day public timelock → `acceptReleaser` (anyone); `release` (Firepit only).
- `Firepit`: `threshold`, `release`, `releaseWithPermit`.
- `DepthToken`: ERC-20 + burn + permit, with no privileged functions.

## Appendix B: Mapping to MiCA Annex I
This mapping is to help prepare a future notified white paper. It is not that white paper.

| Annex I part | Where covered | Still needed |
|---|---|---|
| A: Offeror | — | Entity details |
| D: Project | §1–§5, §8 | Team and advisors |
| E: Offer | §6.2, §10 | Auction terms, price, dates, withdrawal right |
| F: Crypto-asset | §6 | Classification statement |
| G: Rights and obligations | §6.1 | Complaint handling, applicable law |
| H: Technology | §2–§5, Appendix A | Audit reports |
| I: Risks | §9 | Final version with entity-specific risks |
| J: Sustainability | — | Base consensus and energy disclosure |
