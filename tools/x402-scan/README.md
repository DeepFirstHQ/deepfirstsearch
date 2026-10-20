# x402-scan

A free safety scanner for **x402 buyer clients** — the code your AI agent uses to pay for APIs. It attacks your client with the mistakes we keep finding in the wild and tells you which ones it falls for. Zero runtime dependencies, no keys, no chain, nothing settled.

```bash
npx @deepfirstsearch/x402-scan lint https://some-x402-endpoint.example/paid
```

## Why
See **[FINDINGS.md](./FINDINGS.md)** for what we found reviewing a sample of published x402 buyer clients.


An agent that pays over x402 signs a USDC authorization based on a `402` the server sends. If the client trusts that `402` blindly, a hijacked server, a poisoned DNS record or a prompt-injected page can take the agent's money. Scanning a sample of published x402 clients, the same few holes show up again and again:

- it pays **whatever payee** the 402 names (no payee pinning);
- it prices with the **decimals the server declares**, so a huge amount can look like a cent;
- it signs **whatever price** the 402 asks, with no cap;
- it signs authorizations valid for **months**;
- it signs on **any network or token** the 402 names;
- some even sign an **unlimited ERC-2612 Permit** from a 402.

## Two ways to use it

### 1. Lint a live endpoint (no client, no code)

Fetches a URL and flags the traps in its `402` terms — the ones that fool a naive buyer:

```bash
npx @deepfirstsearch/x402-scan lint https://api.example.com/paid
npx @deepfirstsearch/x402-scan lint https://api.example.com/paid -X POST -d '{"q":"hi"}'
```

```
x402-scan lint https://api.example.com/paid → HTTP 402

✗ [permit] asks the buyer to sign an ERC-2612 Permit (an approval, often unlimited)...
✗ [declared_decimals] declares extra.decimals=18 for USDC (which has 6)...
! [long_timeout] authorization validity is 365 days; a buyer should cap it to minutes.

2 dangerous trap(s) in this 402.
```

### 2. Attack a known client — one command, no wiring

If you use one of the common buyer clients, grade it with a single command. Run it in a project where the
client is installed; the scanner builds it the standard way with a throwaway key (no funds, nothing settled)
and reports what it signs:

```bash
npx @deepfirstsearch/x402-scan client @x402/fetch
npx @deepfirstsearch/x402-scan client @x402/axios
```

```
x402-scan client @x402/fetch

· Honest seller (control)   paid the approved payee 0x1111…1111
✗ Swapped payee             signed a payment to the attacker 0x9999…9999
✓ Decimals trick            refused: nothing signed
✗ Price bump                signed 1000000 atomic units, above the owner's price of 10000
…
Grade: F — 4 of 5 safety checks failed.
```

Exit code is `0` only for grade A, so it drops straight into CI. More clients are easy to add — open an issue
or a PR with the adapter.

Add `--json` to either command (`client` or `lint`) for machine-readable output with the same exit codes:

```bash
npx @deepfirstsearch/x402-scan client @x402/fetch --json   # { grade, failures, tests, results: [...] }
npx @deepfirstsearch/x402-scan lint <url> --json           # { status, dangers, findings: [...] }
```

### 3. Attack a custom client (library)

Point your client at the scanner's attack server and see what it signs. Pass a **factory** that makes a fresh client per attack, wired to pay the honest baseline (payee `DEFAULTS.payTo`, `0.01` USDC, Base Sepolia) with your normal settings:

```ts
import { scan, formatReport } from "@deepfirstsearch/x402-scan";

const report = await scan(() => createMyClient({ /* your config */ }).fetch);
console.log(formatReport(report));
```

```
· Honest seller (control)
    paid the approved payee 0x1111…1111
✗ Swapped payee
    signed a payment to the attacker 0x9999…9999
    fix: Pin the payee the owner approved for each origin and refuse any 402 that names another.
✓ Decimals trick
    refused the inflated amount
✗ Price bump
    signed 1000000 atomic units, above the owner's price of 10000
...
Grade: F — 4 of 5 safety checks failed.
```

The adapter is a `(url: string) => Promise<unknown>` that makes one paid request through your client to `url`. For a client that takes a custom `fetch`, baseURL or payment client, it's a couple of lines.

## What it checks

| Attack | A safe client… |
|---|---|
| Swapped payee | refuses a 402 whose `payTo` isn't the one pinned for that origin |
| Decimals trick | prices in the asset's atomic units; ignores server-declared decimals |
| Price bump | pins the price / caps the amount, and refuses or asks above it |
| Year-long authorization | caps the validity window to minutes |
| Foreign network / asset | signs only on the networks and assets the owner allowed |
| (lint) Permit | never signs an ERC-2612 Permit from a 402 |

## The fix for everything it flags

A payee-pinning, budgeted policy layer that runs before any signature. That's exactly what [Agent Safe](https://github.com/DeepFirstHQ/deepfirstsearch) is — but the checks above are good practice with or without it, and this scanner is MIT and standalone.

## Develop

```bash
npm ci && npm test        # unit tests: a naive client fails every check, a safe client passes
npm run build
```

> Reports are responsible: scanning a client or endpoint shows only your own result. We never publish a named result without coordinating with its maintainer first.
