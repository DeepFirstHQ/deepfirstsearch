# Changelog

## 0.5.2 (2026-10-07)

Found by paying CoinGecko over x402 on Base mainnet (Coinbase facilitator):
- **Fix:** the payment payload now echoes the 402's `resource`, as the spec's reference clients do. Merchants settled by Coinbase's facilitator (CoinGecko and others) reject payloads without it ("Facilitator returned 400"). Extensions are still never echoed.
- **Fix:** a receipt with `"errorReason": null` (or a null `payer`/`amount`) is accepted. Before, a paid call was reported as unconfirmed; the SDK resent the same authorization, so nothing was paid twice.
- `resource` in a 402 may carry Bazaar metadata (`serviceName`, `tags`, `iconUrl`, as Glassnode sends); it no longer fails parsing.
- The testing mock merchant gains `cdpStyle` to reproduce both behaviours offline.

## 0.5.1 (2026-10-07)

Found by paying real x402 merchants on Base mainnet (Exa and BlockRun) before showing them to anyone:
- **Fix:** a 402 whose `extra` carries merchant-specific fields (Exa's `breakdown`, `totalUsd`, `acceptId`) was rejected. `extra` is free-form in the spec; unknown keys are now kept, and nothing in it is ever used to sign (the EIP-712 domain comes from the pins).
- **Fix:** a 402 that also offers non-EVM options (Exa offers Solana) was rejected as a whole. Other chains' options now parse and are skipped by the policy; eip155 options keep strict address checks.
- **Fix:** a receipt sent under the x402 v1 header `X-PAYMENT-RESPONSE` (BlockRun) was not recognized, so a settled payment was reported as unconfirmed and a later retry from a new process could pay again. Both header names are read now.

## 0.5.0 (2026-10-06)

- `npx @deepfirstsearch/agent-pay demo`: a 10-second offline tour with a local x402 merchant (no keys, no chain): one honest payment and four attacks refused (payee swap, price hike, injected payee, budget overrun), with the audit chain verified.
- `@deepfirstsearch/agent-pay/testing`: exports `startMockServer`, the offline x402 merchant, for integration tests.

## 0.4.0 (2026-10-06)

- **Owner CLI** (`npx @deepfirstsearch/agent-pay owner …`): `create-vault`, `fund`, `budget`, `status`, `pause`/`unpause`, `revoke`, `withdraw`, `flush-fees`. Keys from a Foundry/geth keystore or `AGENT_PAY_OWNER_KEY`, never from arguments; mainnet transactions need confirmation; `--json` for scripts. `budget` refuses a per-payment cap above the daily cap before signing, and prints a ready-to-paste MCP server entry.
- Exports the official deployments (`AGENT_SAFE`) and the full contract ABIs (`BUDGET_VAULT_FULL_ABI`, `BUDGET_VAULT_FACTORY_ABI`, `FEE_JAR_ABI`), checked against the compiled contracts in CI.

## 0.3.0 (2026-10-06)

Security release from an internal adversarial review of the SDK. Works with Agent Safe contracts v0.3 and later; v0.4 is the current deployment (see `docs/DEPLOYMENTS.md`).

- **Fix (high):** concurrent payments could each pass the plan, period and rate-limit checks before any of them was recorded, and together spend past the limits. Budgets are now reserved synchronously right after the policy decision and released only if nothing was sent.
- **Fix:** the paid request no longer follows redirects, so the payment signature is only ever sent to the merchant's own origin. After a same-origin redirect on the unpaid request, the final URL is the one paid.
- **Fix:** a redirected 402 whose final URL is unknown is denied.
- **Fix:** the kill switch and the plan's expiry are checked again after approval and after funding, right before signing.
- **Fix:** settlement retries resend the same signed authorization (its EIP-3009 nonce can run once), and check that the receipt's network and payer match. If settlement stays unconfirmed, asking for the same resource again resends that authorization instead of signing a second payment.
- **Fix:** text from servers (settlement reasons, schemes, networks, assets) is reduced to short plain tokens before it reaches error messages, so a server cannot write instructions into the agent's context.
- **Fix:** a sanctions screen that throws fails closed. Rate-limit blocks and non-https URLs are denied with a typed error and audited.
- **Breaking:** `SealedPlan.record()` is replaced by `reserve()` and `release()`; plan state is private.
- `vaultFunder`: tops up ahead of time in the background (`prefund`, default on), serializes funding per payer, rejects non-positive amounts, and tops up to the payment itself when it is larger than the tranche (it used to skip that top-up).
- New options: `settleRetries` (0–10, default 3) and `settleRetryDelayMs`, validated when the client is created. New audit event `payment.retry`.

## 0.2.1 (2026-10-06)

- **Fix:** `vaultFunder` waits for 2 confirmations (configurable with `confirmations`) after topping up a payer, before the payment is signed. The facilitator's RPC node could lag behind and fail settlement on the first attempt. Found in the live Base Sepolia run.

## 0.2.0 (2026-10-06)

Requires Agent Safe contracts v0.3 or later (see `docs/DEPLOYMENTS.md`).

- **Breaking:** the intent now includes `burner`, the only payer address the vault may fund. It is signed by the owner, and `fundBurner` to any other address reverts. Use `burnerAddress()` to compute it.
- Added `INTENT_TYPES`, `intentDomain`, `signIntent` and the `Intent` type, so owners don't hand-write the EIP-712 types.
- Added `burnerAddress()`.

## 0.1.0 (2026-10-05)

First release.
