import { afterEach, describe, expect, it } from "vitest";
import { verifyTypedData, type Address } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { x402ResourceServer } from "@x402/core/server";
import { registerExactEvmScheme } from "@x402/evm/exact/server";
import { x402Client } from "@x402/core/client";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { createPaymentWrapper, wrapMCPClientWithPayment } from "@x402/mcp";
import { agentSafeGuard, commitPlan, MerchantRegistry, PINNED_USDC } from "../src/index.js";

/**
 * Some agents pay per MCP tool call: the `@x402/mcp` client handles a payment-required tool result with an
 * `x402Client`, the same client `agentSafeGuard` hooks into. The "origin" is the MCP server the owner configured, so
 * the guard is given its `origin` option (the server URL), and it judges every tool-call payment against it.
 *
 * This runs with a minimal paid MCP server over the SDK's in-memory transport and a local facilitator that verifies
 * the EIP-3009 signature without a chain. No key with funds, nothing settled on-chain.
 */
const NETWORK = "eip155:84532";
const USDC = PINNED_USDC[NETWORK]!.asset as Address;
const SERVER = "https://quote.mcp.example"; // the MCP server URL the owner configures as the origin
const SELLER = "0x1111111111111111111111111111111111111111" as Address;
const ATTACKER = "0x9999999999999999999999999999999999999999" as Address;
const TRANSFER_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" },
  ],
} as const;

/** Counts every signature the server is asked to verify, so "nothing signed" can be checked. */
let signatures = 0;
/** A local facilitator: verifies the EIP-3009 signature and the payee, with no chain; settlement is stubbed. */
const facilitator = {
  async verify(payload: any, req: any) {
    const a = payload.payload.authorization;
    signatures++;
    const ok = await verifyTypedData({
      address: a.from, signature: payload.payload.signature,
      domain: { name: req.extra?.name ?? "USDC", version: req.extra?.version ?? "2", chainId: Number(req.network.split(":")[1]), verifyingContract: req.asset },
      types: TRANSFER_TYPES, primaryType: "TransferWithAuthorization",
      message: { from: a.from, to: a.to, value: BigInt(a.value), validAfter: BigInt(a.validAfter), validBefore: BigInt(a.validBefore), nonce: a.nonce },
    }).catch(() => false);
    if (!ok) return { isValid: false, invalidReason: "invalid_signature" };
    if (a.to.toLowerCase() !== req.payTo.toLowerCase()) return { isValid: false, invalidReason: "invalid_payTo" };
    return { isValid: true, payer: a.from };
  },
  async settle(payload: any, req: any) {
    return { success: true, transaction: `0x${"ab".repeat(32)}`, network: req.network, payer: payload.payload.authorization.from };
  },
  async getSupported() {
    return { kinds: [{ x402Version: 2, scheme: "exact", network: NETWORK }], extensions: [], signers: {} };
  },
};

/** A minimal MCP server with one paid `quote` tool whose 402 names `payTo`. Returns the agent's end of the transport. */
async function paidMcpServer(payTo: Address) {
  const rs = new x402ResourceServer(facilitator as never);
  registerExactEvmScheme(rs);
  await rs.initialize();
  const accepts = await rs.buildPaymentRequirements({ scheme: "exact", network: NETWORK, payTo, price: "$0.001", asset: USDC } as never);
  const paid = createPaymentWrapper(rs, { accepts });
  const server = new McpServer({ name: "quote-server", version: "1.0.0" });
  server.tool("quote", "A paid quote ($0.001)", {}, paid(async () => ({ content: [{ type: "text", text: JSON.stringify({ price: 42 }) }] })) as never);
  const [agentEnd, serverEnd] = InMemoryTransport.createLinkedPair();
  await server.connect(serverEnd);
  return agentEnd;
}

const closers: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((c) => c().catch(() => {})));
});

async function agent(serverPayTo: Address, pinnedPayTo: Address, planSpend = 10_000n) {
  const transport = await paidMcpServer(serverPayTo);
  const payer = privateKeyToAccount(generatePrivateKey());
  const registry = new MerchantRegistry([{ origin: SERVER, payTo: pinnedPayTo, network: NETWORK, maxPerTx: 50_000n, pricePin: 1_000n }]);
  const guard = agentSafeGuard({ registry, plan: commitPlan(registry, [{ origin: SERVER, maxSpend: planSpend }], 600_000), policy: { allowedNetworks: [NETWORK] }, origin: SERVER });
  const client = new Client({ name: "agent", version: "1.0.0" });
  await client.connect(transport);
  const paying = wrapMCPClientWithPayment(client, guard.install(new x402Client().register(NETWORK, new ExactEvmScheme(payer))));
  closers.push(() => client.close());
  return paying;
}
const call = (paying: Awaited<ReturnType<typeof agent>>) =>
  paying.callTool("quote", { symbol: "BTC" }).then((r) => `ok:${JSON.stringify(r.content)}`, (e: Error) => `refused:${e.message}`);

describe("agentSafeGuard with the @x402/mcp client", () => {
  it("pays a tool call at the pinned price to the pinned payee", async () => {
    const before = signatures;
    const r = await call(await agent(SELLER, SELLER));
    expect(r).toMatch(/ok:.*price.*42/);
    expect(signatures - before).toBe(1);
  });

  it("refuses a tool call whose 402 names another payee, with nothing signed", async () => {
    const before = signatures;
    const r = await call(await agent(ATTACKER, SELLER));
    expect(r).toMatch(/payee_mismatch/);
    expect(signatures - before).toBe(0);
  });

  it("stops at the sealed plan across tool calls", async () => {
    const before = signatures;
    const paying = await agent(SELLER, SELLER, 1_000n); // room for exactly one 0.001 payment
    expect(await call(paying)).toMatch(/ok:/);
    expect(await call(paying)).toMatch(/plan_exhausted/);
    expect(signatures - before).toBe(1);
  });
});
