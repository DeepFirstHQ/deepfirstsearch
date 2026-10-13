# Changelog

Reconstructed from the git history; one line per release.

## Unreleased

- Security: `paid_fetch` refuses plain `http` and hosts that are or resolve to loopback, private, link-local or CGNAT addresses unless they are in the sealed plan or `allowPrivateNetwork` is set, and returns redirects instead of following them; errors other than policy refusals reach the model as a fixed text; a settlement transaction is shown only if it is a well-formed hash; `contentType` must be a plain media type. `agentKitPayer` signs only an EIP-3009 `TransferWithAuthorization` from its wallet on pinned USDC and refuses messages.

## History

- **0.2.1 (2026-10-09):** docs only: README matches the repo: offline example, setup note, codes. No code changes.
- **0.2.0 (2026-10-08):** with `@deepfirstsearch/agent-pay` >= 0.8.0, refusal and block texts carry the stable code and what to do about it, e.g. `Payment refused by policy [payee_mismatch → do not retry, report it]` or `Payment blocked [settlement_pending → …]` (`resend_same`).
- **0.1.0 (2026-10-08):** first release: `agentPayActionProvider({ pay, plan })` for Coinbase AgentKit (a `paid_fetch` action with no payee or amount arguments), refusals as text, optional `agentKitPayer(walletProvider)`.
