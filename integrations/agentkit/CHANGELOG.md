# Changelog

Reconstructed from the git history; one line per release.

- **0.2.0 (2026-10-08):** with `@deepfirstsearch/agent-pay` >= 0.8.0, refusal and block texts carry the stable code and what to do about it, e.g. `Payment refused by policy [payee_mismatch → do not retry, report it]` or `Payment blocked [settlement_pending → …]` (`resend_same`).
- **0.1.0 (2026-10-08):** first release: `agentPayActionProvider({ pay, plan })` for Coinbase AgentKit (a `paid_fetch` action with no payee or amount arguments), refusals as text, optional `agentKitPayer(walletProvider)`.
