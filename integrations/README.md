# Integrations

Framework integrations for `@deepfirstsearch/agent-pay`, one package per folder. Each one exposes the same safety model: the plan is sealed before the agent reads untrusted content, the policy runs outside the model, and the vault enforces the budget on-chain.

Available:
- [`mcp/`](mcp/): MCP server for Claude Desktop, Claude Code, Cursor and any MCP client (`paid_fetch`, `list_merchants`, `budget_status`).
- [`ai-sdk/`](ai-sdk/): `paidFetchTool` for the Vercel AI SDK (`generateText`, `streamText`, agents).
- [`langchain/`](langchain/): `createPaidFetchTool` for LangChain.js and LangGraph (`ToolNode`, `createReactAgent`).

Wanted (see the [`integration`](https://github.com/DeepFirstHQ/deepfirstsearch/labels/integration) issues): Coinbase AgentKit action provider, ElizaOS plugin. Read [CONTRIBUTING.md](../CONTRIBUTING.md) first.
