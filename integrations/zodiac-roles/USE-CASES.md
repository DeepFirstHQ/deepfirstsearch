# AI agents that pay for APIs, from a company Safe

Use cases for companies that run AI agents and keep their funds in a Safe. Every case below runs end to end in
[`test/company.fork.test.ts`](test/company.fork.test.ts) on a fork of Base mainnet. The fork uses the canonical
Safe 1.4.1, MultiSendCallOnly and Zodiac Roles 2.1.1 deployments, Circle's real USDC, three vendors paid over x402
through the official facilitator, and `@deepfirstsearch/agent-pay` in front of every payment.

```bash
cd integrations/zodiac-roles && npm ci
BASE_FORK_RPC=https://mainnet.base.org npm test    # needs Foundry's anvil; nothing touches mainnet
```

## Where an agent payment can go wrong

An agent that pays for an API over x402 makes two decisions with company money:

1. **Money leaves the treasury.** Funds move from the company Safe to an address the agent can sign from.
2. **The agent signs a payment.** An API answers `402 Payment Required` with a price and a payee, and the agent signs
   a USDC authorization for it. A facilitator settles it on-chain later.

The two decisions happen in different places, so each one gets its own check:

| | Moment 1: money leaves the Safe | Moment 2: the agent signs a payment |
|---|---|---|
| Where it runs | On-chain, in the Safe's **Zodiac Roles** modifier | In the agent's process, in **Agent Safe**, before any signature |
| Who sets it | The Safe owners (for example 2 of 3: CFO, CTO, Ops) | The same owners, through the agent's registry and policy |
| What it checks | Which payer addresses may receive funds, and how much per day or month, per agent and per team | That the payee is the one registered for the site the agent called, that the price is right, and the session's plan and budget |
| What it stops | A stolen agent key: no other address, no other token, no other function, nothing over the cap | A hijacked or prompt-injected API: a swapped payee or a changed price is refused, and nothing is signed |

In the setup below, the agent's key holds a Roles role and nothing else. Each vendor gets its own payer address,
derived from a seed the company controls, which holds at most one top-up ("tranche") at a time. The company's money
stays in the Safe until a payment needs it.

## The example company

- **Treasury:** a Safe with 1,000 USDC. Any 2 of its 3 owners (CFO, CTO, Ops lead) can change the policy.
- **Research team:** two agents share a budget of 0.10 USDC per day. Each agent has its own cap of 0.06 per day.
  Vendors: a data API and a search API.
- **Support team:** one agent with 0.05 USDC per 30 days. Vendor: a helpdesk API.
- **Prices:** 0.01 USDC per call. Each top-up moves 0.03 USDC to a payer.

(The test amounts are small on purpose; the same calls take any amounts.)

---

### 1. Finance sets the policy once, with the Safe's own approvals

**Situation.** Finance and engineering must both approve which teams and agents can spend company money, and how much.
No single person, and no agent, should be able to change that alone.

**How it works.** The whole policy is built with this package and becomes **one Safe transaction**, through
MultiSendCallOnly. In this example that is 14 calls: enable the Roles module, set the research team budget, and
configure three agent roles (4 calls each). Two owners sign it in the Safe, as with any other company payment.

```ts
const policy = batchCalls([
  { to: safe, data: encodeFunctionData({ abi: safeAbi, functionName: "enableModule", args: [roles] }) },
  ...teamBudgetCalls({ roles, budget: "research", cap: 100_000n }),
  ...agentPayRoleCalls({ roles, usdc, agent: research1, role: "research-1", budget: "research", cap: 60_000n, payers: [r1DataApi, r1SearchApi] }),
  ...agentPayRoleCalls({ roles, usdc, agent: research2, role: "research-2", budget: "research", cap: 60_000n, payers: [r2DataApi] }),
  ...agentPayRoleCalls({ roles, usdc, agent: support1, role: "support-1", cap: 50_000n, period: 30 * 86_400, payers: [s1Helpdesk] }),
], MULTISEND_CALL_ONLY);
```

**What the test proves.** One owner alone is rejected by the Safe (`GS020`). Two owners execute it. An agent trying
to raise its own cap on the Roles modifier is rejected, because only the Safe can change the policy.

### 2. Team budgets (cost centers)

**Situation.** Each team pays for its own tools, and one team's agents must never spend another team's budget.

**How it works.** Each agent gets a role that only accepts its own vendors' payer addresses. A team budget is a Roles
allowance that every agent in the team draws from.

**What the test proves.** Research and support agents pay their vendors over x402. Each team's budget goes down only
by its own top-ups. A research agent's key can't send money to support's payer (`OrViolation`), or to another research
agent's payer (`ParameterNotAllowed`).

### 3. A cap per agent inside the team budget

**Situation.** A team shares a budget, but one agent stuck in a loop should not be able to use up the whole team's
money for the day.

**How it works.** Each top-up must fit **both** the agent's own cap and what is left in the team budget. In Roles, that
is two allowances under an `And` on the amount, set by passing `budget` to `agentPayRoleCalls`.

**What the test proves.** research1 reaches its own cap of 0.06 USDC: Roles refuses the next top-up, and the agent gets
an SDK refusal with code `budget_exhausted` ("wait for the refill"), not an opaque revert. research2 still has 0.03
of its own cap, but the team has only 0.01 left, so its next top-up is refused too. `readAllowance` reports exactly
what Roles will allow: the remaining amount passes, one more unit doesn't. The support team is unaffected throughout.

### 4. Approved vendors only, checked in both places

**Situation.** An agent reads untrusted content all day. A vendor's endpoint can be hijacked, or a page can
prompt-inject the agent toward a different payee. Separately, an agent's key can leak.

**How it works.** In the agent's process, Agent Safe compares every 402 with the payee and price the company
registered for that site, before anything is signed. On-chain, the Roles role only lets the agent's key fund its own
vendors' payers.

**What the test proves.**
- A vendor endpoint that starts asking for payment to an attacker is refused with `payee_mismatch`. Nothing is signed,
  no top-up happens, and the Safe balance doesn't move.
- The agent's key used directly, without the SDK, is refused by Roles: paying the attacker (`ParameterNotAllowed`),
  approving the attacker (`FunctionNotAllowed`), or adding an owner to the Safe (`TargetAddressNotAllowed`).

### 5. Incident response in one Safe transaction

**Situation.** Something looks wrong in one team. The company wants to stop that team's spending now, keep everything
else running, and then cut off the suspect agent for good.

**How it works.** `freezeCalls({ budget: "research" })` sets the team allowance to zero, so every top-up for that team
stops. `revokeAgentCalls` removes one agent's role. Both are ordinary Safe transactions, and they can be batched.

**What the test proves.** After the freeze, research agents can only spend what is already in their payers, at most
one tranche per payer. Measured in the test: 0.02 USDC was outside the Safe when the freeze landed. research2's payer
was empty, so its next payment was refused at once (`budget_exhausted`). Support keeps paying its vendor. The suspect agent is then revoked (`NoMembership`), the freeze is lifted
for the rest of the team in the same transaction, and research2 pays again.

### 6. Monthly budgets that finance can check

**Situation.** Some teams budget per month, and finance wants to know what is left and when it resets.

**How it works.** `period` sets how often an allowance refills (here 30 days, counted from when the Safe set it).
`readAllowance` returns what is available right now, the cap and the next refill time. It is read from the Roles
modifier, so it matches what Roles will enforce.

**What the test proves.** The support agent uses its monthly cap and gets `budget_exhausted`. `readAllowance` reports
the next refill. When the refill lands, the agent pays again.

### 7. Month-end reconciliation from the chain

**Situation.** Finance needs spend per team and per vendor that matches the treasury and each vendor's invoices.

**How it works.** `spendReport` reads the USDC transfers of each labeled payer: what the Safe sent it through Roles,
and what it paid out over x402, by payee. It needs only an RPC.

**What the test proves.** The report's total top-ups equal what left the Safe, to the unit. Each vendor's total equals
that vendor's balance. What is not yet spent sits in the payers, at most one tranche each. Output from the test run:

```
research / research1 / dataApi     topped up 30000  paid 30000 in 3 payments
research / research1 / searchApi   topped up 30000  paid 10000 in 1 payments
research / research2 / dataApi     topped up 60000  paid 40000 in 4 payments
support / support1 / helpdeskApi   topped up 60000  paid 40000 in 4 payments
```

---

## What a company deploys

Nothing new on-chain. The Safe and the Roles modifier are the canonical deployments, and Agent Safe runs inside the
agent's process:

1. The Safe deploys a Roles modifier through the ModuleProxyFactory, with the Safe as owner, avatar and target.
2. For each agent, the company derives one payer address per vendor from a seed it controls (`burnerAddress`).
3. Two owners sign the policy batch (use case 1).
4. Each agent runs `createAgentPay` with the company's vendor registry and `rolesFunder` as its funding hook.
5. Each agent key needs a little ETH on Base for gas: the top-ups are its own transactions through Roles.

## Limits, stated plainly

- **Payers hold up to one tranche.** That is the most a compromised agent can spend outside the policy, per payer.
  Pick the tranche with that in mind.
- **A frozen team can still spend what is in its payers.** At most one tranche per payer, as in use case 5.
- **Payers are a step between the Safe and the vendor.** The Safe itself can sign an x402 payment through ERC-1271
  (USDC accepts it; `test/fork.test.ts`, case 8), but today that needs the owners' signatures for each payment.
  Letting a Roles member authorize those signatures directly is an open design question.
- **Status.** This integration is tested on a Base mainnet fork, in CI. It is not on npm yet, and it is not audited.
  Agent Safe's own contracts are under external audit. This integration uses only the canonical Safe and Roles
  contracts.

> Independent open-source project (MIT), not affiliated with Gnosis Guild or Safe.
