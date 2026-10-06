# Deep First Search: safe x402 payments for AI agents

**Safe rails for the agent economy.** *Search deep. Reveal only what you choose.*

AI agents now pay for things over x402. Every one of those payments is public, and any agent can be talked into paying the wrong party. Deep First Search makes the model **propose** payments while the owner's signed policy **decides**.

[![npm](https://img.shields.io/npm/v/@deepfirstsearch/agent-pay?label=agent-pay)](https://www.npmjs.com/package/@deepfirstsearch/agent-pay) [![MCP](https://img.shields.io/npm/v/@deepfirstsearch/agent-pay-mcp?label=agent-pay-mcp)](https://www.npmjs.com/package/@deepfirstsearch/agent-pay-mcp) [![CI](https://github.com/DeepFirstHQ/deepfirstsearch/actions/workflows/ci.yml/badge.svg)](https://github.com/DeepFirstHQ/deepfirstsearch/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

## Try it in 10 seconds

No keys, no wallet, no chain: a local x402 merchant plays honest and hostile, and you watch the agent pay for data and refuse four attacks.

```bash
npx @deepfirstsearch/agent-pay demo
```

## Pick your path

| You use | Install | Guide |
|---|---|---|
| Claude Desktop, Claude Code, Cursor, any MCP client | `npx @deepfirstsearch/agent-pay-mcp` | [integrations/mcp](integrations/mcp/README.md) |
| Vercel AI SDK | `npm i @deepfirstsearch/agent-pay-ai-sdk` | [integrations/ai-sdk](integrations/ai-sdk/README.md) |
| LangChain.js / LangGraph | `npm i @deepfirstsearch/agent-pay-langchain` | [integrations/langchain](integrations/langchain/README.md) |
| Your own agent, any wallet | `npm i @deepfirstsearch/agent-pay` | [sdk](sdk/README.md) |
| On-chain budgets on Base | `npx @deepfirstsearch/agent-pay owner help` | [owner CLI](sdk/README.md#owner-cli-vault-and-budgets-in-three-commands) |

Full developer guide: **[deepfirstsearch.com/developers](https://deepfirstsearch.com/developers.html)** · building a wallet, framework or platform? **[Partners](https://deepfirstsearch.com/partners.html)**.

## What's in this repository

| Component | What it does | Status |
|---|---|---|
| **MCP server** (`integrations/mcp/`) | Model Context Protocol server: Claude Desktop, Claude Code, Cursor and any MCP client get `paid_fetch`, `list_merchants` and `budget_status` tools that pay x402 APIs inside the owner's budget | ✅ `npx @deepfirstsearch/agent-pay-mcp` · tested with a real Claude session on Base Sepolia |
| **Agent Safe** (`contracts/`) | On-chain vault: owner-signed, timelocked, per-merchant budgets; the agent key can spend but never widen | ✅ 98 tests (fuzzing, invariants, properties, regressions, Base mainnet fork with real USDC), two internal reviews · live on Base mainnet (beta) |
| **agent-pay SDK** (`sdk/`) | x402 v2 client with a policy engine outside the model, prompt-injection guards, per-merchant payers, owner CLI | ✅ 162 tests incl. on-chain loops and the official x402 facilitator · `npx @deepfirstsearch/agent-pay owner …` |
| **Framework tools** (`integrations/`) | Vercel AI SDK `paidFetchTool`, LangChain/LangGraph `createPaidFetchTool` | ✅ on npm |
| **$DEPTH** (`contracts/`) | 1B fixed supply, no mint function, no owner; fees burned through a fee jar + firepit | ✅ Implemented · not launched |
| **Website** (`web/`) | Site, whitepaper, tokenomics, partner kit, legal pages; strict CSP, zero third parties | ✅ |

## MCP server: let Claude or Cursor pay x402 APIs safely

`@deepfirstsearch/agent-pay-mcp` is a stdio MCP server. The model gets three tools and nothing that can move money on its own terms:

| MCP tool | What it does |
|---|---|
| `paid_fetch(url, method?, body?, contentType?)` | Fetches a URL; if it answers `402 Payment Required`, pays in USDC on Base only when the merchant, price and budget match your config |
| `list_merchants()` | Merchants the agent may pay, their prices and the remaining budget |
| `budget_status()` | Remaining budget per merchant, plan window, vault balance |

```json
{ "mcpServers": { "agent-pay": {
    "command": "npx", "args": ["-y", "@deepfirstsearch/agent-pay-mcp", "/path/config.json"],
    "env": { "AGENT_PAY_AGENT_KEY": "0x…", "AGENT_PAY_BURNER_SEED": "0x…" } } } }
```

Payees, prices and limits come from the config file and the owner-signed on-chain budget, never from the model or a 402 response, so a prompt-injected agent can't overspend or pay an attacker. Setup, config reference and a 5-minute Base Sepolia demo: [integrations/mcp](integrations/mcp/README.md).

> Status: pre-launch. **Live on Base Sepolia**, with a [real x402 payment settled](https://sepolia.basescan.org/tx/0x28c60778fcc40110440ec7fb7c944ad28fa90d5a5c26f639a5001c2736d85e5b) (see [deployments](docs/DEPLOYMENTS.md)); **unaudited beta on Base mainnet** since 2026-10-06 (small amounts, our own funds first, then invited design partners) while we arrange an independent audit; the public launch comes after the audit. No token exists.

## Develop on this repository

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
| [Airdrop tool](tools/airdrop/build.mjs) | Builds the airdrop Merkle tree and proofs; tested against the contract |
| [Mainnet runbook](docs/MAINNET.md) | Safes, rehearsal, deploy, checks, guarded launch, monitoring |
| [Security assessment](docs/assessments/SECURITY.md) | Pentest findings, threat model, evidence (ES) |
| [Research](docs/research/) | Market pain, successes, failures, token models, launch mechanics (ES) |

## Key decisions
- **Ticker:** `$DEPTH`.
- **Chain:** Base.
- **Founder:** 12%, nothing for 12 months, then 36 months linear, on-chain; the vesting contract cannot be transferred and the beneficiary is a public Safe.
- **Burn:** burn-to-claim fee jar (no swaps, oracles or admins), fed only by Agent Safe, SDK and inference fees, never by privacy-pool fees.
- **No conference booth** until there are users; hackathons instead.
- **No own privacy pool:** integrate a third-party compliant one (ADR-011). Sales geo-blocked for the US and Argentina (ADR-012).

## Security
See [SECURITY.md](SECURITY.md) to report vulnerabilities.

## Contact

Built by Nicolas Tursi. General contact: hello@deepfirstsearch.com. Security reports: see [SECURITY.md](SECURITY.md) or write to security@deepfirstsearch.com.

## License
MIT (contracts and SDK).
