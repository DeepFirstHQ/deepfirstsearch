# Risk Disclosure

> **Draft v0.1, October 2026. Not yet reviewed by counsel.** No token exists. This page describes the risks of the software and of any future token so that nobody relies on anything we did not say.

## Software risks
- **Smart-contract risk.** Contracts can contain bugs that lead to the loss of all funds they hold. Audits reduce this risk; they do not remove it. **The mainnet beta runs before the independent audit is finished:** use only amounts you can afford to lose. Our contracts are immutable, so a bug cannot be patched in place.
- **Agent risk.** AI agents can be manipulated (for example by prompt injection) or simply make mistakes. Agent Safe limits how much an agent can lose; it cannot make a bad purchase a good one. You choose and are responsible for the limits you set.
- **Key risk.** Whoever controls your keys controls your funds. Lost keys cannot be recovered by anyone.
- **Privacy limits.** In the current version, each merchant sees a different payer address, but the funding of those addresses is visible on-chain and can be traced by a determined analyst. Full unlinkability requires the planned shielded pool, which does not exist yet. Network-level metadata (IP addresses, timing) can also reveal information unless you take your own precautions.
- **Third-party risk.** The software depends on Base, USDC, x402 facilitators and other systems we do not control. Any of them can fail, censor transactions or change their rules.

## Token risks (if a token is ever distributed)
- **Total loss.** A token can lose all of its market value.
- **No rights.** The token gives no ownership, dividend, profit share, voting right over any company, or claim on any revenue.
- **Burns are mechanical, not a promise.** Fees can be small or zero. The burn mechanism reduces supply only when someone chooses to use it, and says nothing about price.
- **Liquidity.** There may be no market, or a thin one with large price swings.
- **Regulation.** Laws on tokens and privacy software are changing quickly in the US, the EU, Argentina and elsewhere. A change could restrict the token, the software, exchanges' willingness to list the token, or your ability to use them.
- **Tax.** You are responsible for your own taxes.

## What we will never do
Promise returns, guarantee a price, pay anyone to promote the token, or describe the token as an investment. If someone does any of those things in our name, it is not us.
