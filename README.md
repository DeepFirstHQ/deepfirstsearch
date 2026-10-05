# Deep First Search ($DEPTH)

**Safe rails for the agent economy.** *Search deep. Reveal only what you choose.*

AI agents now pay for things over x402. Every one of those payments is public, and any agent can be talked into paying the wrong party. Deep First Search makes the model **propose** payments while the owner's signed policy **decides**.

| Component | What it does | Status |
|---|---|---|
| **Agent Safe** (`contracts/`) | On-chain vault: owner-signed, timelocked, per-merchant budgets; the agent key can spend but never widen | ✅ 57 tests (fuzzing, invariants, universal properties) + 5 against a Base mainnet fork with real USDC, 100% line coverage, Slither + Aderyn triaged |
| **agent-pay SDK** (`sdk/`) | x402 v2 client with a policy engine outside the model, prompt-injection guards, per-merchant payers, ERC-5564 | ✅ 50 tests incl. a full on-chain loop (vault → payer → **official x402 facilitator** settles) and exchange-funded payers · `npm run demo` |
| **$DEPTH** (`contracts/`) | 1B fixed supply, no mint function, no owner; fees burned through a fee jar + firepit | ✅ Implemented · TGE only after revenue |
| **Website** (`web/`) | Apple-style scroll site, whitepaper, tokenomics, legal pages; strict CSP, zero third parties | ✅ |

> Status: pre-launch. **Live on Base Sepolia**, with a [real x402 payment settled](https://sepolia.basescan.org/tx/0x28c60778fcc40110440ec7fb7c944ad28fa90d5a5c26f639a5001c2736d85e5b) (see [deployments](docs/DEPLOYMENTS.md)); mainnet waits for an independent security review. No token exists.

## Quick start

```bash
# Contracts (needs Foundry: curl -L https://foundry.paradigm.xyz | bash && foundryup)
git submodule update --init --recursive
cd contracts && forge test

# SDK
cd ../sdk && npm ci && npm test && npm run demo

# Website
cd ../web && npm ci && npm run dev
```

## Documents

| | |
|---|---|
| [Whitepaper](docs/WHITEPAPER.md) | Formal design, privacy model, risks (EN; structured for MiCA Annex I) |
| [Tokenomics](docs/TOKENOMICS.md) | Supply, allocation, Firepit burn, vesting (EN) |
| [Decisions](docs/DECISIONS.md) | ADRs: ticker, chain, burn, vesting, stand… (ES) |
| [Deployments](docs/DEPLOYMENTS.md) | Base Sepolia contract addresses and the live demo vault |
| [Audit scope](docs/audit/SCOPE.md) | Scope, nSLOC, roles, known issues and questions for reviewers |
| [Mainnet runbook](docs/MAINNET.md) | Safes, rehearsal, deploy, checks, guarded launch, monitoring |
| [Security assessment](docs/assessments/SECURITY.md) | Pentest findings, threat model, evidence (ES) |
| [Research](docs/research/) | Market pain, successes, failures, token models, launch mechanics (ES) |

## Key decisions
- **Ticker:** `$DEPTH`.
- **Chain:** Base.
- **Founder:** 12%, nothing for 12 months, then 36 months linear, on-chain and non-transferable.
- **Burn:** burn-to-claim fee jar (no swaps, oracles or admins), fed only by Agent Safe, SDK and inference fees, never by privacy-pool fees.
- **No conference booth** until there are users; hackathons instead.
- **No own privacy pool:** integrate a third-party compliant one (ADR-011). Sales geo-blocked for the US and Argentina (ADR-012).

## Security
See [SECURITY.md](SECURITY.md) to report vulnerabilities.

## Contact

Built by Nicolas Tursi. General contact: hello@deepfirstsearch.com. Security reports: see [SECURITY.md](SECURITY.md) or write to security@deepfirstsearch.com.

## License
MIT (contracts and SDK).
