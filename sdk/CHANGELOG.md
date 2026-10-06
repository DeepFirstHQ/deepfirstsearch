# Changelog

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
