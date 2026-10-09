#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig, loadSecrets } from "./config.js";
import { buildServer, payerAddresses } from "./server.js";

// stdout carries the MCP protocol; anything else goes to stderr.
const path = process.argv[2] ?? process.env.AGENT_PAY_MCP_CONFIG;
if (!path) {
  console.error("usage: agent-pay-mcp <config.json>   (or set AGENT_PAY_MCP_CONFIG)");
  process.exit(1);
}
try {
  const config = loadConfig(path);
  const secrets = loadSecrets(process.env, Boolean(config.vault));
  const { server } = buildServer(config, secrets);
  await server.connect(new StdioServerTransport());
  console.error(`agent-pay-mcp ready on ${config.network} with ${config.merchants.length} merchant(s)`);
  // Without a vault you fund each merchant's payer yourself: say which address that is (#27).
  if (!config.vault) {
    for (const { label, payer } of payerAddresses(config, secrets)) console.error(`  fund ${payer} with USDC to pay ${label}`);
  }
} catch (e) {
  console.error(`agent-pay-mcp: ${(e as Error).message}`);
  process.exit(1);
}
