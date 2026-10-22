/**
 * A Cloudflare Agent that pays for MCP tools over x402 — inside the owner's budget, even if prompt-injected.
 *
 * The Agents SDK's `withX402Client` handles the payment; `agentSafeConfirmation` from
 * `@deepfirstsearch/agent-pay-cloudflare` decides whether each payment is allowed. The model can call any tool, but a
 * tool that asks for payment is paid ONLY to the pinned payee, on the allowed network, in USDC, within the per-call cap,
 * the price pin and the session budget. A swapped payee, a price hike, a different token or a prompt-injected
 * "pay http://.../pay-me" is refused, and nothing is signed.
 *
 * This file shows the wiring. The policy itself is covered by the tests in
 * `integrations/cloudflare/test/confirmation.test.ts` (honest payment approved, swapped payee refused, caps, price pin,
 * network/asset allowlist, multi-option, session budget).
 */
import { Agent } from "agents";
import { withX402Client } from "agents/x402";
import { privateKeyToAccount } from "viem/accounts";
import { agentSafeConfirmation } from "@deepfirstsearch/agent-pay-cloudflare";

type Env = {
  /** The agent's EVM key (a burner the owner funds). Store it as a Worker secret, never in code. */
  AGENT_PRIVATE_KEY: `0x${string}`;
};

// The owner's rules for the one paid MCP server this agent uses. Everything here is owner configuration, not model input.
const RESEARCH_MCP = {
  origin: "https://mcp.research.example", // a label for this server
  payTo: "0xYourMerchant0000000000000000000000000000", // the ONLY address the agent may pay
  network: "eip155:8453", // Base
  maxPerTx: 50_000n, // ≤ 0.05 USDC per call (atomic units; USDC has 6 decimals)
  pricePin: 10_000n, // the expected 0.01 USDC price; anything higher is refused
} as const;

export class ResearchAgent extends Agent<Env> {
  async onRequest(request: Request): Promise<Response> {
    // Connect to the paid MCP server (see the Agents SDK MCP docs for how you create `mcpClient`).
    const mcpClient = await this.mcp.connect("https://mcp.research.example/sse");

    // Wrap it so Agent Safe decides every payment. One wrapped client → one server → one merchant rule set.
    const paid = withX402Client(mcpClient, {
      account: privateKeyToAccount(this.env.AGENT_PRIVATE_KEY),
      network: "eip155:8453", // pin the network the client pays on
      confirmationCallback: agentSafeConfirmation({
        merchant: RESEARCH_MCP,
        sessionBudget: 100_000n, // ≤ 0.10 USDC total for this request's session
        onRefusal: (r) => console.warn("payment refused:", r.code, r.detail),
      }),
    });

    // The model drives which tools to call; the code above decides what gets paid.
    const report = await paid.callTool(null, { name: "market_report", arguments: { ticker: "ETH" } });

    return Response.json(report);
  }
}
