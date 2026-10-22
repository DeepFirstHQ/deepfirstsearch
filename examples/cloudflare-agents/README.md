# A Cloudflare Agent that pays safely

A [Cloudflare Agent](https://developers.cloudflare.com/agents/) that pays for paid MCP tools over x402 — but only
the payee the owner pinned, on the allowed network, in USDC, within a per-call cap, a price pin and a session budget.
A prompt-injected agent can't overspend, pay a different wallet, or accept a price hike. Nothing outside the rules is
signed.

The Agents SDK's [`withX402Client`](https://developers.cloudflare.com/agents/tools/payments/x402/) makes the payment and
asks a confirmation callback whether it's allowed; [`@deepfirstsearch/agent-pay-cloudflare`](https://github.com/DeepFirstHQ/deepfirstsearch/tree/main/integrations/cloudflare)
*is* that callback, built from the owner's rules.

See [`src/agent.ts`](./src/agent.ts) for the wiring — three steps: connect the MCP client, wrap it with
`withX402Client` + `agentSafeConfirmation`, then let the agent call tools.

```ts
const paid = withX402Client(mcpClient, {
  account: privateKeyToAccount(env.AGENT_PRIVATE_KEY),
  network: "eip155:8453",
  confirmationCallback: agentSafeConfirmation({ merchant, sessionBudget: 100_000n }),
});
await paid.callTool(null, { name: "market_report", arguments: { ticker: "ETH" } });
```

## Install

```bash
npm i @deepfirstsearch/agent-pay-cloudflare @deepfirstsearch/agent-pay agents viem
```

## What's verified

The policy is covered by unit tests in
[`integrations/cloudflare/test/confirmation.test.ts`](https://github.com/DeepFirstHQ/deepfirstsearch/blob/main/integrations/cloudflare/test/confirmation.test.ts):
an honest payment is approved, a swapped payee is refused with nothing signed, and so are an over-cap amount, a price
above the pin, a disallowed network, a swapped token (the "declared decimals" trick), and a payment that would exceed
the session budget. A 402 that mixes a safe option with an unsafe one is refused in full, because the client — not the
callback — chooses which option to pay.

To check what an x402 client signs **without** this guard, in one command:

```bash
npx @deepfirstsearch/x402-scan client @x402/fetch
```
