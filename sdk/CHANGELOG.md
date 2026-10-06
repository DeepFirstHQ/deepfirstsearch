# Changelog

## 0.2.1 (2026-10-06)

- **Fix:** `vaultFunder` waits for 2 confirmations (configurable with `confirmations`) after topping up a payer, before the payment is signed. The facilitator's RPC node could lag behind and fail settlement on the first attempt. Found in the live Base Sepolia run.

## 0.2.0 (2026-10-06)

Requires Agent Safe contracts v0.3 (see `docs/DEPLOYMENTS.md`).

- **Breaking:** the intent now includes `burner`, the only payer address the vault may fund. It is signed by the owner, and `fundBurner` to any other address reverts. Use `burnerAddress()` to compute it.
- Added `INTENT_TYPES`, `intentDomain`, `signIntent` and the `Intent` type, so owners don't hand-write the EIP-712 types.
- Added `burnerAddress()`.

## 0.1.0 (2026-10-05)

First release.
