# Changelog

## 0.2.0 (2026-10-06)

Requires Agent Safe contracts v0.3 (see `docs/DEPLOYMENTS.md`).

- **Breaking:** the intent now includes `burner`, the only payer address the vault may fund. It is signed by the owner, and `fundBurner` to any other address reverts. Use `burnerAddress()` to compute it.
- Added `INTENT_TYPES`, `intentDomain`, `signIntent` and the `Intent` type, so owners don't hand-write the EIP-712 types.
- Added `burnerAddress()`.

## 0.1.0 (2026-10-05)

First release.
