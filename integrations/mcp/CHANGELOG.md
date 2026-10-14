# Changelog

Reconstructed from the git history; one line per release.

- **0.4.0 (2026-10-14):** the `verified` preset (`"preset": "verified"`): 35 sellers on Base whose payee and price were confirmed with a real payment, re-checked live without paying (`scripts/verify-preset.ts`); `presetOnly`, `presetExclude` and `presetMaxSpend` choose and cap them, your own entries always win, and `periodBudget` is required (#43). New free tool `check_price(url)`: asks the owner's policy what it would do with that URL's payment terms, without paying (agent-pay `dryRun`): the price and payee it would pay, or the refusal code and what to do about it. No payment header is ever sent, redirects are not followed, and the same internal-address rules as `paid_fetch` apply (#41).
- **0.3.0 (2026-10-13):** on agent-pay 0.11.0 (never a second signature while the first may pay). Security: `paid_fetch` refuses plain `http` and hosts that are or resolve to loopback, private, link-local or CGNAT addresses unless they are a configured merchant or `allowPrivateNetwork` is set, and returns redirects instead of following them; errors other than policy refusals reach the model as a fixed text (details on stderr), so an `rpcUrl` API key can't leak; a settlement transaction is shown only if it is a well-formed hash; unknown config keys are rejected; `AGENT_PAY_BURNER_SEED` must be whole bytes (an even number of hex digits).
- **0.2.1 (2026-10-09):** on agent-pay 0.8.5: reads v2 receipts whose network is a v1 short name (Automaton Sovereign's origin).
- **0.2.0 (2026-10-09):** on agent-pay 0.8.4. Per-merchant `x402Versions` (x402 v1 merchants such as Heurist Mesh). `confirmOnChain` (default on): an unreadable receipt is checked on-chain instead of resent, so CoinMarketCap, JustaName and Glim work through MCP. Without a vault, prints each merchant's payer address on start (#27).
- **0.1.8 (2026-10-08):** depends on `@deepfirstsearch/agent-pay` 0.8.0; refusals and blocks show their stable code and what to do about it, e.g. `Payment refused by policy [price_changed → ask the owner]` or `Payment blocked [settlement_pending → …]` (`resend_same`).
- **0.1.7 (2026-10-08):** per-merchant `maxTimeoutSeconds` (10 to 86400 s) in the config (#29, thanks @Priyadharshan2003); on agent-pay 0.6.2. Closes #15.
- **0.1.6 (2026-10-07):** on agent-pay 0.6.1; refusals detected by error name; reports its real version.
- **0.1.5 (2026-10-07):** on agent-pay 0.5.3 (x402 v1 alias fields, 16 KiB 402 headers).
- **0.1.4 (2026-10-07):** on agent-pay 0.5.2 (Coinbase-facilitated merchants, `errorReason: null` receipts).
- **0.1.3 (2026-10-07):** on agent-pay 0.5.1 (free-form `extra`, non-EVM options skipped, `X-PAYMENT-RESPONSE` receipts).
- **0.1.2 (2026-10-06):** published to the official MCP registry as `com.deepfirstsearch/agent-pay-mcp` (domain-verified).
- **0.1.1 (2026-10-06):** `server.json` and `mcpName` for the official MCP registry.
- **0.1.0 (2026-10-06):** first release: `paid_fetch`, `list_merchants` and `budget_status` tools; merchants, prices and caps from a config file, keys from the environment (#1).
