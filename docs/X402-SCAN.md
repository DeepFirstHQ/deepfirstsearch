# x402-scan

**A free safety scanner for the code your AI agent uses to pay.** It attacks your
x402 buyer client with the mistakes we keep finding in the wild, and tells you which
ones it falls for. MIT, zero dependencies, no keys, no chain, nothing settled.

```bash
npx @deepfirstsearch/x402-scan lint https://some-x402-endpoint.example/paid
```

> **Best practice:** scan every buyer client, on every release — and put a
> payee-pinning, budgeted policy layer in front of every signature. The scan tells
> you *what* your client gets wrong; [Agent Safe](./developers.html) is the layer
> that makes it right, and keeps it right as the code changes. Run both. A client
> that passes today can regress tomorrow; a policy layer refuses the bad signature
> either way.

## Why this matters

An agent that pays over x402 signs a USDC authorization based on a `402` the server
sends. If the client trusts that `402` blindly, a hijacked server, a poisoned DNS
record or a prompt-injected page can take the agent's money. Reviewing a sample of
published x402 buyer clients, the same few holes show up again and again:

- it pays **whatever payee** the `402` names — no check that the recipient is the
  one you approved for that site (a redirected `402` sends the money to an attacker);
- it prices with the **decimals the server declares**, so a huge amount can read as a
  cent and slip under a dollar cap;
- it signs **whatever price** the `402` asks, with no cap;
- it signs authorizations valid for **months**;
- it signs on **any network or token** the `402` names;
- some even sign an **unlimited ERC-2612 Permit** from a `402` — an open-ended
  approval an attacker can drain later.

See [FINDINGS.md](https://github.com/DeepFirstHQ/deepfirstsearch/blob/main/tools/x402-scan/FINDINGS.md)
for what we found across roughly two dozen published clients.

## Two ways to use it

### 1. Lint a live endpoint — no client, no code

Fetches a URL and flags the traps in its `402` terms, the ones that fool a naive buyer:

```bash
npx @deepfirstsearch/x402-scan lint https://api.example.com/paid
npx @deepfirstsearch/x402-scan lint https://api.example.com/paid -X POST -d '{"q":"hi"}'
```

```
x402-scan lint https://api.example.com/paid → HTTP 402

✗ [permit] asks the buyer to sign an ERC-2612 Permit (an approval, often unlimited)…
✗ [declared_decimals] declares extra.decimals=18 for USDC (which has 6)…
! [long_timeout] authorization validity is 365 days; a buyer should cap it to minutes.

2 dangerous trap(s) in this 402.
```

### 2. Attack your own client — in code

Point your client at the scanner's local attack server and see what it signs. You pass
a factory that makes a fresh client per attack, wired to pay the honest baseline; the
scanner swaps the payee, inflates the decimals, bumps the price, stretches the window
and changes the network, and grades what your client lets through.

```ts
import { scan, formatReport } from "@deepfirstsearch/x402-scan";

const report = await scan(() => createMyClient({ /* your config */ }).fetch);
console.log(formatReport(report));
```

```
· Honest seller (control)   paid the approved payee 0x1111…1111
✗ Swapped payee             signed a payment to the attacker 0x9999…9999
✓ Decimals trick            refused the inflated amount
✗ Price bump                signed 1000000 atomic units, above the owner's price of 10000
…
Grade: F — 4 of 5 safety checks failed.
```

## What a safe buyer client does

1. **Pin the payee per origin** and refuse a `402` that names another.
2. **Price in the asset's own atomic units** — never trust the decimals a server declares.
3. **Cap the price (or amount) per call**, and the budget per session.
4. **Bound the authorization window** to minutes.
5. **Allow only the networks and assets the owner configured**, and never sign an
   ERC-2612 Permit from a `402` — the exact scheme never needs one.

These five are good practice with or without any product. But keeping them true by
hand, on every call and every release, is the hard part.

## The fix for everything it flags

A payee-pinning, budgeted policy layer that runs **before any signature**. That is
exactly what **[Agent Safe](./developers.html)** is: it pins the payee per origin,
prices in atomic units, caps the spend per call and per session, bounds the window,
and refuses anything outside the policy — so a tampered `402` is rejected instead of
signed. The scanner and the layer are two halves of one habit:

- **Scan** to see what your client gets wrong today.
- **Run the layer** so it can't get it wrong tomorrow.

```bash
npx @deepfirstsearch/agent-pay demo
```

The scanner is MIT and standalone — use it even if you never adopt Agent Safe. But if
it grades your client anything short of A, the shortest path to an A, and to staying
there, is the policy layer.

## Links

- Scanner source: <https://github.com/DeepFirstHQ/deepfirstsearch/tree/main/tools/x402-scan>
- Findings: <https://github.com/DeepFirstHQ/deepfirstsearch/blob/main/tools/x402-scan/FINDINGS.md>
- Agent Safe (the policy layer): [developer guide](./developers.html)

> Reports are responsible: scanning a client or endpoint shows only your own result.
> We never publish a named result without coordinating with its maintainer first.
