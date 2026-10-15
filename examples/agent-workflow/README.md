# One complete agent workflow

An AI SDK agent researches a task, reads free and paid sources, and meets every outcome a seller can produce: it pays
an approved seller, refuses a hijacked one, stops at its budget, asks its owner when a price moves, uses a free source,
skips a 404 and survives a dead host. Every outcome comes back as a value with the next step to take, never as an
exception. The model chooses which sources to read; the code decides every payment.

```bash
git clone https://github.com/DeepFirstHQ/deepfirstsearch && cd deepfirstsearch/examples/agent-workflow
npm i
npm start          # local: mock sellers, no keys, no chain
npm test           # the same, as assertions
```

It uses the published packages: `@deepfirstsearch/agent-pay` 0.12.0 and `@deepfirstsearch/agent-pay-ai-sdk` 0.4.0.

## What the agent sees (`npm start`)

```
source                 outcome           what the agent does
market data /prices    paid              use the data; keep the receipt (0.01 USDC to 0x1111…1111)
market data /prices    paid              use the data; keep the receipt (0.01 USDC to 0x1111…1111)
market data /prices    refused           try again later (plan_exhausted)
market data /premium   refused           ask the owner before going further (price_changed)
hijacked mirror        refused           stop using this source and report it to the owner (payee_mismatch)
unknown seller         refused           tell the owner the setup is missing something (unknown_merchant)
free FX rates          no_challenge      use the data (nothing was paid)
market data /missing   no_challenge      skip this source (HTTP 404, no terms)
dead source            transport_failure retry once, then give up on this source

Payment authorizations received: { honest: 2, mirror: 0, stranger: 0 }
```

Step by step:
1. **Paid, twice.** The seller is in the owner's registry, its payee and price match the pins, and the sealed plan
   allows 0.02 USDC for it this session. The agent keeps each receipt.
2. **`plan_exhausted` → `retry_later`.** A third call would go over the plan sealed before the agent read anything.
3. **`price_changed` → `ask_owner`.** `/premium` asks 0.05, above the 0.01 the owner pinned. A person decides.
4. **`payee_mismatch` → `report`.** A mirror of the same seller now names an attacker as payee, as a hijacked server
   or DNS record would. Nothing is signed: the mirror receives zero payment authorizations.
5. **`unknown_merchant` → `fix_config`.** A seller the owner never approved. The agent can't add it.
6. **`no_challenge`, 200.** A free source: use the data.
7. **`no_challenge`, 404.** No terms were shown. Skip it; a free route, a free trial or a missing page all look like
   this, and the same URL can ask for payment next time.
8. **`transport_failure`.** The request failed before any answer. Not a payment decision: retry once, then give up.

## How it works

- [`src/workflow.ts`](src/workflow.ts): `fetchSource` reads the seller's terms with `dryRun` (no key, nothing signed),
  pays through `pay.fetch` only when the policy allows them, and returns one `Outcome`. `nextStep` turns each outcome
  into what the agent does. `runTask` gives both tools (`today`, free; `fetch_source`) to any AI SDK model.
- [`src/world.ts`](src/world.ts): the owner's setup (registry, policy, sealed plan) and the local sellers.
- [`src/scripted-model.ts`](src/scripted-model.ts): a stand-in for an LLM so this runs without an API key. Replace it
  with any AI SDK model, for example `openai("gpt-5")` from `@ai-sdk/openai`: the tools and every payment decision stay
  the same.

## Live, read-only (`npm run live-readonly`)

The agent's first step against a real seller, with no key and no payment: two URLs suggested in issue #40 by the
seller's developer, a free route and a paid route. When we ran it on 2026-10-15, both answered 200 with no terms
(`no_challenge`): the paid route was in a free trial for new callers. When it asks for payment again, the same code
returns `refused` with `unknown_merchant`, because that seller is not in this registry.

## Base Sepolia (`npm run sepolia`)

The same agent against a real x402 seller on Base Sepolia that settles on-chain through the public facilitator
(`https://x402.org/facilitator`, which pays the gas), plus a hijacked mirror of it.

1. Make a throwaway key: `node -e "console.log(require('viem/accounts').generatePrivateKey())"`. Never a key with real funds.
2. Get a little Base Sepolia USDC for its address at https://faucet.circle.com (0.05 is plenty). No ETH is needed.
3. `PAYER_KEY=0x… SELLER=0x… npm run sepolia` (`SELLER` defaults to the payer itself, so the USDC comes back).

What we saw on 2026-10-15:

```
market data        paid          use the data; keep the receipt (0.01 USDC to 0x85D1…5d4A)  https://sepolia.basescan.org/tx/0x613e5addd7c41af6fb123b2a02ea20434d2695e8c9cba816e80e226cdfd9d09a
hijacked mirror    refused       stop using this source and report it to the owner (payee_mismatch)
market data again  refused       try again later (plan_exhausted)
```

On Base mainnet, the payer would be funded from an owner-signed BudgetVault instead (`vaultFunder`, see
[docs/DEVELOPERS.md](../../docs/DEVELOPERS.md)).
