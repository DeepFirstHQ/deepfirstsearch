# Changelog

Reconstructed from the git history; one line per release.

- **Unreleased (0.3.1):** explicit `Tool` return type; compiles under `exactOptionalPropertyTypes`.
- **0.3.0 (2026-10-08):** with `@deepfirstsearch/agent-pay` >= 0.8.0, refusals and blocks carry a stable `code` and an `action` (`report`, `ask_owner`, `fix_config`, `retry_later`, `resend_same`).
- **0.2.0 (2026-10-07):** `@deepfirstsearch/agent-pay`, `ai` and `zod` are peer dependencies (one SDK copy per app); refusals detected by error name.
- **0.1.3 (2026-10-07):** on agent-pay 0.5.3.
- **0.1.2 (2026-10-07):** on agent-pay 0.5.2.
- **0.1.1 (2026-10-07):** on agent-pay 0.5.1.
- **0.1.0 (2026-10-06):** first release: `paidFetchTool({ pay, plan })` for `generateText`/`streamText` (#3).
