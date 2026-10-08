# Integrations

Framework integrations for `@deepfirstsearch/agent-pay`, one package per folder. Each one exposes the same safety model: the plan is sealed before the agent reads untrusted content, the policy runs outside the model, and the vault enforces the budget on-chain.

Available:
- [`mcp/`](mcp/): MCP server for Claude Desktop, Claude Code, Cursor and any MCP client (`paid_fetch`, `list_merchants`, `budget_status`).
- [`ai-sdk/`](ai-sdk/): `paidFetchTool` for the Vercel AI SDK (`generateText`, `streamText`, agents).
- [`privy/`](privy/): `privyPayer`, a Privy server wallet as the payer (Privy's own viem adapter; signatures verified to recover to the wallet).
- [`turnkey/`](turnkey/): `turnkeyPayer`, a Turnkey-held key as the payer (signs the EIP-712 digest inside Turnkey).
- [`langchain/`](langchain/): `createPaidFetchTool` for LangChain.js and LangGraph (`ToolNode`, `createReactAgent`).
- [`agentkit/`](agentkit/): `agentPayActionProvider({ pay, plan })` for Coinbase AgentKit: a `paid_fetch` action with no payee or amount arguments.
- [`order-guard/`](order-guard/): `createOrderGuard`, owner-set limits for agents that place real orders (approved stores, pinned delivery address, order and tip caps, daily budget, single-use previews).
- [`zodiac-roles/`](zodiac-roles/): a Safe gives an agent an x402 budget through Zodiac Roles v2 (`rolesFunder`). Proof of concept, tested on a Base mainnet fork; not on npm yet.

The tool integrations take `@deepfirstsearch/agent-pay` as a peer dependency, so an app always runs a single copy of the SDK.

Wanted (see the [`integration`](https://github.com/DeepFirstHQ/deepfirstsearch/labels/integration) issues): Coinbase AgentKit action provider, ElizaOS plugin. Read [CONTRIBUTING.md](../CONTRIBUTING.md) first.
