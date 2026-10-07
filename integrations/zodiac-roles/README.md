# Zodiac Roles v2 × Agent Safe (proof of concept, not published)

> Not on npm yet: clone the repository and run it from `integrations/zodiac-roles` (`npm ci && npm test`; the Base-fork tests need anvil and `BASE_FORK_RPC`).

A Safe gives an AI agent an x402 budget through **Zodiac Roles v2**, without moving the funds out of the Safe. The agent can top up its per-merchant payer addresses from the Safe, and nothing else:

- Only `USDC.transfer(to, amount)`.
- `to` must be one of the payer addresses the owner listed (one per merchant, derived in advance).
- `amount` is within a Roles allowance that refills daily.
- No other function, no other contract, no ETH, no delegatecall.

The SDK then pays each x402 merchant from its payer as usual: payee and price pins, sealed plan, refusals before signing.

```ts
import { agentPayRoleCalls, rolesFunder } from "./src/index.js";

// Owner side: the four calls the Safe executes on its Roles modifier (scopeTarget, scopeFunction, setAllowance, assignRoles).
const calls = agentPayRoleCalls({ roles, usdc, agent: agent.address, payers: [payerForMerchantA, payerForMerchantB], dailyCap: 100_000n });

// Agent side: the SDK tops up a payer through Roles before paying, when the payer can't cover the payment.
const pay = createAgentPay({ registry, policy, payer: burnerPayers(seed, safe), session,
  ensureFunded: rolesFunder({ agent: agentWallet, publicClient, roles, usdc, tranche: 40_000n, payers }) });
```

## Run the tests

```bash
npm ci
npm test                                                        # unit tests; the fork suite is skipped
BASE_FORK_RPC=https://base-rpc.publicnode.com npm test           # + the Base mainnet fork suite (needs Foundry's anvil)
```

The fork suite uses the canonical Safe 1.4.1 and Roles 2.1.1 deployments and Circle's real USDC on a local fork, plus the official x402 facilitator settling on-chain. Nothing touches mainnet. It covers:

1. A 1-of-1 Safe is deployed and given its Roles modifier, and the agent is given the `agent-pay` role.
2. The agent pays a merchant over x402. The SDK tops up the payer from the Safe once, then pays from it.
3. A compromised agent key calling Roles directly is refused on-chain:
   - paying the attacker: `ParameterNotAllowed`;
   - over the daily cap: `AllowanceExceeded`;
   - `approve`: `FunctionNotAllowed`;
   - calling the Safe: `TargetAddressNotAllowed`;
   - delegatecall: `DelegateCallNotAllowed`;
   - a non-member: `NotAuthorized`.
4. The daily allowance also stops the SDK, and refills after a day.
5. With several merchants, the condition is an Or of the payer addresses.
6. Open question, path b: USDC accepts an EIP-3009 authorization signed by the Safe itself (ERC-1271).

Addresses come from `@gnosis-guild/zodiac` 5.0.1 and `@safe-global/safe-deployments` 1.37.63, and were checked on Base with `eth_getCode`.

> Proof of concept, unaudited. Independent project, not affiliated with Gnosis Guild or Safe.
