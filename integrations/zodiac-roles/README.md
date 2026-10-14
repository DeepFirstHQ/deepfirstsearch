# Zodiac Roles v2 × Agent Safe

> Preview, not on npm yet: clone the repository and run it from `integrations/zodiac-roles` (`npm ci && npm test`; the Base-fork suites need Foundry's anvil and `BASE_FORK_RPC`).

A Safe gives its AI agents x402 budgets through **Zodiac Roles v2**, without moving the funds out of the Safe. Each
agent can top up its per-vendor payer addresses from the Safe, and nothing else:

- Only `USDC.transfer(to, amount)`.
- `to` must be one of the payer addresses the owners listed (one per vendor, derived in advance).
- `amount` must fit the agent's own Roles allowance, and its team's budget when it has one. Both refill per period.
- No other function, no other contract, no ETH, no delegatecall.

Agent Safe then checks each x402 payment before the agent signs it: payee and price pinned per site, a sealed plan,
and refusal codes the agent can act on.

**For companies:** [USE-CASES.md](USE-CASES.md) has three scenarios (a fund's research desk, treasury monitoring for a
DAO, counterparty checks before payouts) and eight use cases: team budgets, per-agent caps inside a team, a 2-of-3
finance policy signed once, incident response, monthly budgets, month-end reconciliation and human approval for large
purchases. Each use case runs end to end on a Base mainnet fork.

```ts
import { agentPayRoleCalls, batchCalls, rolesFunder, teamBudgetCalls } from "./src/index.js";

// Owners: the policy as one Safe transaction (MultiSendCallOnly, operation 1).
const policy = batchCalls([
  ...teamBudgetCalls({ roles, budget: "research", cap: 100_000_000n }),            // 100 USDC a day for the team
  ...agentPayRoleCalls({ roles, usdc, agent: agent.address, role: "research-1", budget: "research",
    cap: 60_000_000n, payers: [payerForVendorA, payerForVendorB] }),               // at most 60 of it for this agent
], multiSendCallOnly);

// Agent: the SDK tops up a payer through Roles only when it can't cover the payment.
const pay = createAgentPay({ registry, policy, payer: burnerPayers(seed, safe), session,
  ensureFunded: rolesFunder({ agent: agentWallet, publicClient, roles, usdc, role: "research-1", tranche: 5_000_000n }) });
```

## API

| Function | Who uses it | What it does |
|---|---|---|
| `agentPayRoleCalls({ roles, usdc, agent, payers, cap, period?, role?, budget? })` | Owners | The role for one agent: `transfer` to its payers only, within its cap (and its team's budget) |
| `teamBudgetCalls({ roles, budget, cap, period? })` | Owners | A budget shared by a team's agents. Calling it again changes the cap or lifts a freeze |
| `freezeCalls({ roles, budget })` / `freezeCalls({ roles, role })` | Owners | Stops every top-up for a team, or for one agent, at once |
| `revokeAgentCalls({ roles, agent, role? })` | Owners | Takes the role away from an agent |
| `batchCalls(calls, multiSendCallOnly)` | Owners | Any of the above as one Safe transaction (delegatecall to MultiSendCallOnly) |
| `rolesFunder({ agent, publicClient, roles, usdc, tranche, role?, payers? })` | Agent | `ensureFunded` hook for `createAgentPay`. Roles refusals come back as `PaymentDeniedError` with code `budget_exhausted` or `policy_denied` |
| `readAllowance({ publicClient, roles, key })` | Finance | Available now, cap, period and next refill, accrued as Roles does. Keys: `budgetKey(name)`, `agentAllowanceKey(role)` |
| `spendReport({ publicClient, usdc, safe, payers, fromBlock })` | Finance | Top-ups and payments per labeled payer, by payee, from USDC transfer logs |
| `spendLedger({ publicClient, usdc, safe, payers, fromBlock, audit? })` / `ledgerCsv(rows)` | Finance | One row per movement (time, transaction, team, payee, amount, site paid), as CSV for accounting |

The agent's key can be any viem account, including one held by a custodian: tested live with a Privy server wallet and a
Coinbase CDP server account (`test/custody.live.test.ts`, needs credentials; see [USE-CASES.md](USE-CASES.md)).

All the owner functions return plain `{ to, data }` calls, so they work with the Safe{Wallet} transaction builder,
the Safe SDK or any other way the company already signs Safe transactions.

## Run the tests

```bash
npm ci
npm test                                                  # unit tests; the fork suites are skipped
BASE_FORK_RPC=https://mainnet.base.org npm test           # + both Base mainnet fork suites (needs Foundry's anvil)
CUSTODY_CREDS_DIR=… BASE_FORK_RPC=https://mainnet.base.org npx vitest run test/custody.live.test.ts   # live: Privy / CDP keys
```

The fork suites use the canonical Safe 1.4.1, MultiSendCallOnly and Roles 2.1.1 deployments and Circle's real USDC on a
local fork, plus the official x402 facilitator settling on-chain. Nothing touches mainnet. CI runs them on every push.

[`test/company.fork.test.ts`](test/company.fork.test.ts) covers the eight company use cases in [USE-CASES.md](USE-CASES.md).
[`test/fork.test.ts`](test/fork.test.ts) covers the basics, one agent and one Safe owner:

1. A 1-of-1 Safe is deployed and given its Roles modifier, and the agent is given the `agent-pay` role.
2. The agent pays a merchant over x402. The SDK tops up the payer from the Safe once, then pays from it.
3. A compromised agent key calling Roles directly is refused on-chain:
   - paying the attacker: `ParameterNotAllowed`;
   - over the daily cap: `AllowanceExceeded`;
   - `approve`: `FunctionNotAllowed`;
   - calling the Safe: `TargetAddressNotAllowed`;
   - delegatecall: `DelegateCallNotAllowed`;
   - a non-member: refused.
4. The daily allowance also stops the SDK, and refills after a day.
5. With several merchants, the condition is an Or of the payer addresses.
6. Open question: USDC accepts an EIP-3009 authorization signed by the Safe itself (ERC-1271).

Addresses come from `@gnosis-guild/zodiac` 5.0.1 and `@safe-global/safe-deployments` 1.37.63, and were checked on Base
with `eth_getCode`.

> Preview, not audited. Independent open-source project (MIT), not affiliated with Gnosis Guild or Safe.
