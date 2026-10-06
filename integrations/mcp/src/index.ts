#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig, loadSecrets } from "./config.js";
import { buildServer } from "./server.js";

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
} catch (e) {
  console.error(`agent-pay-mcp: ${(e as Error).message}`);
  process.exit(1);
}
