# The state of x402 buyer-side safety

AI agents can pay for things now. With [x402](https://x402.org), an agent that hits a
`402 Payment Required` reads the price from the response, signs a USDC authorization, and
retries — no human in the loop. That is the point, and it works. The question nobody is
asking loudly enough is the other half: **when an agent pays, who checks what it is
paying for?**

Because the agent signs based on a `402` that a *server* sends. If the client trusts that
`402` blindly, then a hijacked server, a poisoned DNS record, or a prompt-injected page
that changes where the agent browses can change where the agent's money goes. The
signature is still valid. The USDC still moves. It just moves to the wrong place.

So in October 2026 we read a sample of **published x402 "buyer" clients** — the npm and
PyPI packages an agent actually uses to pay — and, where we could, pointed each one at a
local server with a throwaway key (no funds, nothing settled) to see what it would sign.
We built [`x402-scan`](./x402-scan.html) out of that review so anyone can run the same
checks in one command.

## What we found

Across roughly two dozen buyer clients, the same few holes show up again and again:

- **About 4 in 10 signed a payment to whatever payee the `402` named.** No check that the
  recipient is the one the owner expected for that site. Redirect the `402` — by
  compromising the server, the DNS, or the page the agent is reading — and the agent signs
  its payment straight to an attacker. This is the big one.
- **A couple priced the payment using the decimals the server declared.** USDC has 6
  decimals. A `402` that *declares* 18 makes a **1,000 USDC** charge read as a fraction of
  a cent — so it slides under a one-dollar cap and gets signed. The amount the owner sees
  and the amount that moves are not the same number.
- **Several signed authorizations valid for months**, or on **any network and token** the
  `402` named — far more standing permission than a single API call needs.

The rest already pin the payee and cap spend. The space is maturing. But a large minority
still treat the server's `402` as if it were trustworthy, and on a payment rail that is the
whole ballgame.

> These results are aggregate and anonymized — we name no client. Where we found a sharp,
> specific issue in a particular package, we reported it privately to its maintainer first,
> and gave them time to fix it. This write-up is about the pattern, not about naming names.

## What a safe buyer client does

The fixes are not exotic. A client that pays safely over x402:

1. **Pins the payee per origin** and refuses a `402` that names a different one.
2. **Prices in the asset's own atomic units** — and never trusts the decimals a server
   declares.
3. **Caps the price (or the amount) per call, and the budget per session.**
4. **Bounds the authorization window** to minutes, not months.
5. **Allows only the networks and assets the owner configured**, and never signs an
   open-ended approval (an ERC-2612 Permit) out of a `402` — the exact scheme never needs one.

Each of these is a few lines on its own. The hard part is keeping all five true on every
call, in every code path, as the code changes — which is exactly where a reviewed client
quietly regresses.

## Check your own client — one command

```bash
npx @deepfirstsearch/x402-scan client @x402/fetch
```

It builds the client the standard way with a throwaway key, attacks it with each of the
traps above, and grades what it signs. No funds, no chain, nothing settled. There is also a
`lint` mode that flags the traps in any live `402` endpoint's terms. See the
[x402-scan page](./x402-scan.html), or follow the step-by-step
[guide to auditing and securing your agent's payments](./guides/SECURE-AGENT-PAYMENTS.md).

## The durable fix

The checks above are good practice with or without any product. But keeping them true by
hand, forever, is the part that fails. The reliable way is a **payee-pinning, budgeted
policy layer that runs before any signature** — it pins the payee per origin, prices in
atomic units, caps spend per call and per session, bounds the window, and refuses anything
outside the policy, so a tampered `402` is rejected instead of signed.

That is what we build: **[Agent Safe](./developers.html)**. The scanner tells you what your
client gets wrong today; the policy layer makes sure it can't get it wrong tomorrow. Run
both.

```bash
npx @deepfirstsearch/agent-pay demo
```

Agents that can spend are here. Agents that can spend *safely* are a choice — and right
now, too often, the default is the unsafe one.
