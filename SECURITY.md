# Security policy

## Reporting a vulnerability

Please **do not** open a public issue for security problems.

Report privately to security@deepfirstsearch.com or through a confidential issue in the repository (GitLab → New issue → "This issue is confidential"), with:

- the affected component (`contracts/`, `sdk/`, `web/`) and commit;
- a description and, if possible, a proof of concept (a Foundry test or a script);
- your preferred contact for follow-up.

We aim to acknowledge reports within 24 hours and to agree on a disclosure date with you. A paid bug bounty will be announced before mainnet.

## Scope

- Smart contracts in `contracts/src`
- The `@deepfirstsearch/agent-pay` SDK in `sdk/src`
- The website in `web/`

Out of scope: third-party services (Base, USDC, x402 facilitators), social engineering, denial of service by volume.

## Design summary

See [docs/assessments/SECURITY.md](docs/assessments/SECURITY.md) for the threat model, findings and test evidence.
