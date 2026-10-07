# Contributing

Thanks for helping. Deep First Search builds **Agent Safe**: x402 payments for AI agents that stay inside an owner-signed budget, even if the agent is prompt-injected. The most useful contributions right now are **integrations** that let agents in popular frameworks pay through it, and anything that makes the first hour with it smoother.

Start with an issue labeled [`good first issue`](https://github.com/DeepFirstHQ/deepfirstsearch/labels/good%20first%20issue) or [`integration`](https://github.com/DeepFirstHQ/deepfirstsearch/labels/integration). Comment on it before you start so two people don't build the same thing. Questions go to [Discussions](https://github.com/DeepFirstHQ/deepfirstsearch/discussions).

## Layout

| Path | What |
|---|---|
| `sdk/` | `@deepfirstsearch/agent-pay` (TypeScript): x402 client, policy engine, guards, vault funding |
| `contracts/` | Agent Safe contracts (Solidity, Foundry): `BudgetVault`, `BudgetVaultFactory`, `FeeJar`, and the token contracts |
| `integrations/` | Framework integrations (MCP, LangChain, AI SDK, AgentKit…), one package per folder |
| `docs/` | Whitepaper, deployments, security assessments, audit scope |
| `web/` | deepfirstsearch.com |

## Setup

```bash
git clone --recursive https://github.com/DeepFirstHQ/deepfirstsearch && cd deepfirstsearch
cd contracts && forge build && forge test && cd ..   # needs Foundry
cd sdk && npm ci && npm run typecheck && npm test     # Node 22+; the on-chain tests run when anvil is installed
```

To see a real payment end to end on Base Sepolia (free, about 1 hour because of the vault's timelock), follow the quickstart in [`sdk/README.md`](sdk/README.md).

## Pull requests

- One topic per PR, with tests. CI runs the contracts, the SDK (including on-chain tests against anvil) and the website.
- Match the surrounding style. `forge fmt` for Solidity; the SDK has no runtime dependencies beyond viem, zod and the x402 packages, so ask before adding one.
- Integrations live in `integrations/<name>/` with their own `package.json`, a README with a copy-paste example, and at least one test that drives a payment against the mock x402 server in `sdk/examples/mock-x402-server.ts`.
- **Contracts are frozen for review.** Changes to `contracts/src` need an issue and a maintainer's OK first, because every change re-opens the audit scope.
- Never commit private keys, seeds or `.env` files, even testnet ones.

## Sensitive changes and AI-assisted PRs

This code moves money, so some changes need a maintainer's OK in the issue **before** you open a PR. Otherwise the PR is closed:
- anything under `.github/` (workflows, actions, templates);
- new dependencies, version bumps, `package.json` scripts (especially `preinstall`/`postinstall`/`prepare`) or publishing config;
- `contracts/src`, and the signing, policy and decoding code in `sdk/src/x402`, `sdk/src/policy` and `sdk/src/wallet`.

Every diff is reviewed line by line before merging, and an automatic PR guard checks the diff for risky changes (see [docs/REVIEWING.md](docs/REVIEWING.md)). Pull requests from forks run CI without secrets, and nothing is published from a PR.

AI-assisted contributions are welcome. Say so in the PR. You should understand every line and be able to explain it in review. Tests must exercise the behavior they claim to; a test that would pass without your change doesn't count.

## Security

Don't open public issues for vulnerabilities. Report them privately as described in [SECURITY.md](SECURITY.md).

## License

By contributing you agree that your contribution is licensed under the MIT license of this repository.
