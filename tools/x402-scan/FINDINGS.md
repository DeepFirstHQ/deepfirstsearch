# The state of x402 buyer-side safety

An agent that pays over x402 signs a USDC authorization based on a `402` a server sends. If the client trusts that
`402` blindly, a hijacked server, a poisoned DNS record or a prompt-injected page can take the agent's money. So in
October 2026 we reviewed a sample of **published x402 "buyer" clients** — the npm/PyPI packages an agent uses to pay —
reading each one and, where we could, pointing it at a local server with a throwaway key (no funds, nothing settled)
to see what it would sign.

We built [`x402-scan`](./README.md) out of this review. It runs the same checks on any client or endpoint.

## What we found

Across roughly two dozen buyer clients:

- **About 4 in 10 signed a payment to whatever payee the `402` named** — no check that the recipient is the one the
  owner expected for that site. A redirected `402` sends the agent's money to an attacker.
- **A couple priced the payment with the decimals the server declared.** A `402` that declares 18 decimals for USDC
  (which has 6) makes a **1,000 USDC** payment read as a fraction of a cent, so it slips under a dollar cap and gets
  signed.
- **Several signed authorizations valid for months**, or on **any network and token** the `402` named.

The rest already pin the payee and cap spend — the space is maturing, but a large minority still don't. These are
aggregate, anonymized results: we name no client. Where we found a sharp issue, we reported it privately to the
maintainer first.

## What a safe buyer client does

1. **Pin the payee per origin** and refuse a `402` that names another.
2. **Price in the asset's own atomic units** — never trust the decimals a server declares.
3. **Cap the price (or amount) per call**, and the budget per session.
4. **Bound the authorization window** to minutes.
5. **Allow only the networks and assets the owner configured**, and never sign an ERC-2612 Permit from a `402` (the
   exact scheme never needs one).

## Check your own client

```bash
npx @deepfirstsearch/x402-scan lint <your-endpoint>
```

Or attack your client in code — see the [README](./README.md). The fix for everything it flags is a payee-pinning,
budgeted policy layer that runs before any signature; that's what we build ([Agent Safe](https://github.com/DeepFirstHQ/deepfirstsearch)),
but the checks are good practice with or without it.
