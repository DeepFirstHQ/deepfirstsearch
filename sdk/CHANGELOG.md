# Changelog

## Unreleased

- **Audit:** `payment.signed` now records `declaredOrigin` when the 402's own resource URL (v2 `resource.url`, or v1's per-option `resource`) names a different origin from the one the agent contacted. It is the server's self-description, so it is logged and never used for a decision: the merchant is always the contacted origin (suggested by Automaton Sovereign in cloudflare/agents#2544).

## 0.8.5 (2026-10-09)

- **Fix:** a v2 `PAYMENT-RESPONSE` whose `network` is a v1 short name (`"base"`), as Automaton Sovereign's origin sends, was treated as unreadable and the client fell back to `X-Payment-Settled`. Known short names are now mapped through the fixed table to CAIP-2 (unknown ones are still rejected), so the standard receipt is read and the "settled on the network we signed" check applies to it.

## 0.8.4 (2026-10-09)

- **Fix:** replay refusals are matched as a family, keyed by meaning rather than one string: `nonce_replayed_local` (and the rest of Automaton Sovereign's per-path variants, read from its code by its maintainer) now classify as `settled_not_delivered` too. Never re-signed either way.

## 0.8.3 (2026-10-09)

Found paying Automaton Sovereign (x402 v2 on Base) live, with its maintainer verifying from the seller side:
- **Fix:** a 402 whose options repeat the network as `chainId` / `networkV1` or carry Bazaar's `outputSchema` was rejected. Those fields are accepted now, informational only; `chainId` and `networkV1` must agree with `network` or the whole 402 is rejected.
- **Changed:** vendor keys at the top level of a 402 (instructions, trial info, legacy copies) are dropped instead of rejecting the 402; they are never read or echoed. Keys that look like payment terms (`payTo`, `amount`, `asset`, `network`, `to`, `recipient`, …) outside `accepts` still reject it, and every option inside `accepts` stays strict.
- **Fix:** the "already used" classifier missed `nonce_already_used_locally` (the seller's real answer to a replayed proof). It now matches every variant seen live (`tx_already_used`, `nonce_already_used_locally`, "nonce already used").
- With `X-Payment-Settled`, a well-formed `X-Payment-Tx` header is reported as `settlement.transaction`.

## 0.8.2 (2026-10-08)

Never a second signature while the first might have paid (raised in coinbase/agentkit#1544):
- **Fix:** an unconfirmed authorization that expired used to be dropped and a new one signed. If the first had executed before expiring (only the receipt was unreadable), that could pay twice. Now, past expiry plus a 60 s clock margin, the chain decides through `confirmAuthorization` (unused → sign a new one; used → `settled_not_delivered`, never paid again). Without an on-chain check the payment is blocked with the new code `settlement_unknown` (ask the owner) until `pay.forgetUnsettled(url)`. Close to expiry nothing is sent or signed (`settlement_pending`).
- A merchant answering a resend with "already used" (e.g. `402 payment_invalid / reason: tx_already_used`, or "nonce already used") is classified `settled_not_delivered` without an RPC call, and that resource is not paid again.
- `X-Payment-Settled: true | queued` on a 2xx without a standard receipt is accepted once (no resend, no RPC) and surfaced as `res.payment.merchantSettled`.
- New audit events: `payment.settled_by_merchant`, `payment.expired_unused`, `payment.forgotten`.

## 0.8.1 (2026-10-08)

- **Fix (types):** `usdcAuthorizationCheck`, `oracleScreen` and `vaultFunder` take only the client methods they use (`Pick<PublicClient, …>`, exported as `ReadClient` for the first), so a chain-specific client such as `createPublicClient({ chain: base, transport: http() })` typechecks under `strict`. Found by typechecking every documented sample against the published packages.

## 0.8.0 (2026-10-08)

Refusals carry stable reason codes (suggested in coinbase/agentkit#1544):
- `PaymentDeniedError` gains `codes` (one stable, machine-readable code per reason), `code` (the primary one: the most cautious action wins, then the first listed) and `action` (`report`, `ask_owner`, `fix_config` or `retry_later`). The closed set is exported as `REFUSAL_CODES` with `RefusalCode`, `RefusalAction`, `isRefusalCode`, `refusalAction` and `primaryRefusalCode`; see "Refusal codes" in the README.
- Every refusal path in the policy engine and the client maps to a code, for x402 v1 and v2 alike: e.g. `payee_mismatch` / `network_mismatch` / `asset_mismatch` (possible redirection: don't retry, report it), `price_changed` (the 402's price moved above the owner's pin: ask the owner), `over_cap` (above the per-payment cap: ask the owner), `plan_exhausted` / `budget_exhausted` (retry later or ask for a bigger plan).
- The `payment.denied` audit event records `codes` next to `reasons`; `payment.approval_refused` records `codes: ["human_refused"]`. A denied `evaluate` decision carries `codes` parallel to `reasons`.
- Backwards compatible: the human-readable reasons are unchanged, and `new PaymentDeniedError(reasons)` still works (every reason gets `policy_denied`). Unknown codes passed to the constructor become `policy_denied`. No check, order or signing behaviour changed.
- `PaymentBlockedError` carries a code and action too (`BLOCK_CODES`): `settlement_pending` (the payment may have settled; request the same resource again, the same authorization is resent and nothing new is signed), `settled_not_delivered` (paid on-chain, not delivered: never pay again, report it), `rate_limited`, `kill_switch`. Also suggested in coinbase/agentkit#1544.

## 0.7.0 (2026-10-08)

Opt-in x402 v1 support, per merchant (#14):
- `Merchant.x402Versions` (default `[2]`). A merchant whose entry sets `[1, 2]` (or `[1]`) may be paid over x402 v1; for every other merchant a v1 402 is refused with a reason naming the option. There is no global switch and no automatic downgrade. The registry rejects an empty, duplicated or unknown version list.
- v1 402s are read from the JSON body (at most 32 KiB, strict schema; resource metadata and `outputSchema` are informational and never echoed). Network names map to CAIP-2 only through a fixed table (`base`, `base-sepolia`); options on other networks, such as Browserbase's `solana`, are skipped. The amount is `maxAmountRequired`. After mapping, every existing policy check applies unchanged.
- The payment goes in `X-PAYMENT` as the reference v1 client sends it (`{x402Version: 1, scheme, network, payload: {signature, authorization}}`), signed with the pinned EIP-712 domain. The receipt is read from `X-PAYMENT-RESPONSE` with the same strictness as v2 (its network must map to what was signed). One signature per payment, retries and later requests resend the same header, and `confirmAuthorization` covers v1 too.
- Merchants that hand out a new `payTo` on every 402 (Browserbase deposit addresses) stay refused under payee pinning, with the "payTo … is not the merchant's registered address" reason.
- The testing mock merchant gains per-route `x402Version: 1` and `tamperV1`, and `MockServer.receivedV1`. Tests replay 402s captured from Heurist Mesh and Browserbase.
- Exported schemas gain `PaymentRequiredV1`, `PaymentRequirementsV1`, `PaymentPayloadV1`, `SettleResponseV1`, `V1_NETWORKS` and `HEADERS.v1Signature`.

## 0.6.3 (2026-10-08)

Found by paying x402 merchants on Base mainnet (#33):
- **Fix:** with `confirmAuthorization`, a paid request answered with 2xx but no readable receipt now goes straight to the on-chain check instead of resending the spent authorization. CoinMarketCap sends a non-standard receipt (`txHash`, `networkId`) and answers a resend with a new 402, so the delivered data was lost.
- The on-chain check is asked up to 4 times, `settleRetryDelayMs` apart, because a merchant can answer before its settlement transaction is mined.
- **Fix:** a 402 option that repeats the x402 v1 resource metadata (`resource`, `description`, `mimeType`, as Interzoid sends) was rejected. Those keys are accepted now, size-bounded and informational only.

## 0.6.2 (2026-10-08)

- `viem` is now a range (`^2.38.0`) instead of an exact pin, so apps that also use Coinbase AgentKit (which pins viem 2.38) get a single viem and no type clashes. Tested against viem 2.38.3 and 2.57.3.

## 0.6.1 (2026-10-07)

- `startMockServer(routes, { network })`: the offline mock merchant can speak Base mainnet (`eip155:8453`) as well as Base Sepolia (the default), so code written for mainnet runs against it unchanged. Found by a newcomer walkthrough of the docs.

## 0.6.0 (2026-10-07)

- `confirmAuthorization` option and `usdcAuthorizationCheck(clients)`: when a merchant's receipt is missing or unreadable after the retries (Robtex sends `{settled: true, method: "direct"}`), the SDK asks USDC whether the signed authorization was used on-chain. Used and delivered: the payment counts as settled (`payment.confirmedOnChain`). Used but not delivered: a clear error, never resent. Not used, or the check fails: unconfirmed, as before. No extra RPC calls on the normal path (#16).
- Audit event `payment.settled_onchain`. The testing mock merchant gains `rawReceipt`.

## 0.5.5 (2026-10-07)

- Per-merchant authorization window: `Merchant.maxTimeoutSeconds` (integer, 10 to 86400, validated when the registry is built) overrides `policy.timeoutBounds.max` for that merchant only, in both the policy check and the signed validity window. Useful for merchants that ask for long authorizations (OneSource asks for 3600 s). Thanks @Priyadharshan2003 (#21).

## 0.5.4 (2026-10-07)

- The 402 is also read from `X-PAYMENT-REQUIRED` when `PAYMENT-REQUIRED` is absent (Ordiscan sends it there). The standard header wins when both are present, an invalid standard header never falls back, and the alias goes through the same size cap, strict schema and policy. First outside contribution, thanks @aqibmohd271 (#18).

## 0.5.3 (2026-10-07)

Found by paying 14 x402 merchants on Base mainnet:
- **Fix:** a 402 option that repeats the x402 v1 fields next to the v2 ones (`currency`, `maxAmountRequired`, `recipient`, as OneSource sends) was rejected. They are accepted now only when they agree with `asset`, `amount` and `payTo`; a disagreeing alias rejects the 402.
- **Fix:** the 402 header limit rises from 8 to 16 KiB. Bazaar listings with input/output schemas (Otto sends ~10 KiB) were refused as too large.

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
