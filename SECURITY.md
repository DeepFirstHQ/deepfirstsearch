# Security policy

## Reporting a vulnerability

Please **do not** open a public issue for security problems.

Report privately to security@deepfirstsearch.com or through GitHub private vulnerability reporting (https://github.com/DeepFirstHQ/deepfirstsearch/security/advisories/new), with:

- the affected component (`contracts/`, `sdk/`, `integrations/`, `web/`) and commit;
- a description and, if possible, a proof of concept (a Foundry test or a script);
- your preferred contact for follow-up.

We aim to acknowledge reports within 24 hours and to agree on a disclosure date with you. A paid bug bounty will be announced before the public mainnet launch. During the unaudited mainnet beta, please report anything you find here; good-faith research is welcome.

## Scope

- Smart contracts in `contracts/src`
- The `@deepfirstsearch/agent-pay` SDK in `sdk/src`, including its CLI
- The integration packages in `integrations/` (MCP server, payer adapters, agent-framework tools, order-guard)
- The release workflows in `.github/workflows/`
- The website in `web/`

Out of scope: third-party services (Base, USDC, x402 facilitators), social engineering, denial of service by volume.

## Design summary

See [docs/assessments/SECURITY.md](docs/assessments/SECURITY.md) for the threat model, findings and test evidence, [docs/audit/PREAUDIT-2026-10.md](docs/audit/PREAUDIT-2026-10.md) for the latest internal review (every finding and its status), and [docs/audit/SCOPE.md](docs/audit/SCOPE.md) for what a reviewer needs to start.
