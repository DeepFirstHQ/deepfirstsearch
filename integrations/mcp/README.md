# @deepfirstsearch/agent-pay-mcp

An MCP server that lets any MCP agent (Claude Desktop, Claude Code, Cursor, …) **pay x402 APIs in USDC on Base without being able to overspend**, even if a web page or API response prompt-injects it.

> **Beta, unaudited.** Use Base Sepolia or small amounts on Base mainnet.

The model gets three tools and nothing else:

| Tool | What the model can do |
|---|---|
| `paid_fetch(url, method?, body?, contentType?)` | Fetch a URL. If it answers `402 Payment Required`, the payment goes through only if the merchant, price and budget match **your** config |
| `list_merchants()` | See which origins it may pay, their prices and what's left |
| `budget_status()` | Remaining budget per merchant, window renewal, vault balance |

The model **cannot** choose a payee, an amount, a network or a limit: there is no argument for any of them. Merchants, price pins, caps and the spending plan come from your config file; keys come from environment variables. Responses are returned inside a randomly tagged fence marked as untrusted data. On-chain, the [Agent Safe](https://github.com/DeepFirstHQ/deepfirstsearch) vault enforces your signed per-payment and per-day caps even if this machine is compromised.

## Setup

1. **Budget (owner, once):** create a vault and sign a budget per merchant with the [owner CLI](https://github.com/DeepFirstHQ/deepfirstsearch/tree/main/sdk#owner-cli-vault-and-budgets-in-three-commands): `npx @deepfirstsearch/agent-pay owner create-vault`, then `owner budget …`, which prints the `intentId` and a ready-to-paste `merchants[]` entry. (No vault? Leave out `vault`, `tranche` and `intentId` and fund the payer addresses yourself.)
2. **Config:** copy [`config.example.json`](config.example.json) and fill it in. Amounts are USDC decimal strings. Keep `tranche` at or below each intent's `trancheCap` and `maxPerTx`.
3. **Secrets (environment only):**
   - `AGENT_PAY_AGENT_KEY`: the intent's agent key (needed with a vault).
   - `AGENT_PAY_BURNER_SEED`: the 32-byte secret the payer addresses were derived from. Never your owner key.

### Claude Code

```bash
claude mcp add agent-pay \
  -e AGENT_PAY_AGENT_KEY=0x… -e AGENT_PAY_BURNER_SEED=0x… \
  -- npx -y @deepfirstsearch/agent-pay-mcp /absolute/path/config.json
```

### Claude Desktop / Cursor

`claude_desktop_config.json` (Claude Desktop) or `.cursor/mcp.json` (Cursor):

```json
{
  "mcpServers": {
    "agent-pay": {
      "command": "npx",
      "args": ["-y", "@deepfirstsearch/agent-pay-mcp", "/absolute/path/config.json"],
      "env": { "AGENT_PAY_AGENT_KEY": "0x…", "AGENT_PAY_BURNER_SEED": "0x…" }
    }
  }
}
```

From source instead of npm: `cd integrations/mcp && npm ci && npm run build`, then use `node /path/to/integrations/mcp/dist/index.js` as the command.

## Config reference

| Field | Meaning |
|---|---|
| `network` | `eip155:84532` (Base Sepolia) or `eip155:8453` (Base) |
| `vault`, `tranche` | Agent Safe vault that tops up each merchant's payer, and the top-up size |
| `merchants[].origin`, `payTo` | Who may be paid, and the only address the payment can go to |
| `merchants[].price`, `tolerancePct` | Expected price per call; anything above `price × (1 + tolerance)` is refused |
| `merchants[].maxPerTx`, `maxSpend` | Hard cap per call, and per merchant per plan window |
| `planWindowHours` | The plan is sealed from this file at start and renewed from it every window |
| `periodBudget` | Total across merchants per period |
| `approvalAbove` | Payments above this are refused (this server has no approval channel the model can't reach) |
| `sessionHasSensitiveData` | If the agent can also read private data, every payment needs a human (Rule of Two), so all are refused |
| `auditLog` | Hash-chained JSONL log of every decision |

## Develop

```bash
npm ci && npm run typecheck && npm test   # tests drive the server through an MCP client against a mock x402 merchant
```
