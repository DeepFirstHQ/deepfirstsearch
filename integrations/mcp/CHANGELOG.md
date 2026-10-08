# Changelog

Reconstructed from the git history; one line per release.

- **0.1.8 (2026-10-08):** depends on `@deepfirstsearch/agent-pay` 0.8.0; refusals and blocks show their stable code and what to do about it, e.g. `Payment refused by policy [price_changed → ask the owner]` or `Payment blocked [settlement_pending → …]` (`resend_same`).
- **0.1.7 (2026-10-08):** per-merchant `maxTimeoutSeconds` (10 to 86400 s) in the config (#29, thanks @Priyadharshan2003); on agent-pay 0.6.2. Closes #15.
- **0.1.6 (2026-10-07):** on agent-pay 0.6.1; refusals detected by error name; reports its real version.
- **0.1.5 (2026-10-07):** on agent-pay 0.5.3 (x402 v1 alias fields, 16 KiB 402 headers).
- **0.1.4 (2026-10-07):** on agent-pay 0.5.2 (Coinbase-facilitated merchants, `errorReason: null` receipts).
- **0.1.3 (2026-10-07):** on agent-pay 0.5.1 (free-form `extra`, non-EVM options skipped, `X-PAYMENT-RESPONSE` receipts).
- **0.1.2 (2026-10-06):** published to the official MCP registry as `com.deepfirstsearch/agent-pay-mcp` (domain-verified).
- **0.1.1 (2026-10-06):** `server.json` and `mcpName` for the official MCP registry.
- **0.1.0 (2026-10-06):** first release: `paid_fetch`, `list_merchants` and `budget_status` tools; merchants, prices and caps from a config file, keys from the environment (#1).
