import { describe, expect, it } from "vitest";
import { decodeFunctionData, erc20Abi, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { agentPayRoleCalls, rolesFunder, roleKey, ROLES_ABI } from "../src/index.js";

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address;
const ROLES = "0x1111111111111111111111111111111111111111" as Address;
const payer = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const merchant = { origin: "https://m.example", payTo: "0x2222222222222222222222222222222222222222" as Address, network: "eip155:8453", maxPerTx: 50_000n };

function fakes(startBalance: bigint) {
  let balance = startBalance;
  const sent: { to: Address; amount: bigint; roleKey: string }[] = [];
  const agent = {
    account: { address: "0x3333333333333333333333333333333333333333" }, chain: undefined,
    writeContract: async (a: { address: Address; args: readonly unknown[] }) => {
      expect(a.address).toBe(ROLES);
      const [to, , data, op, key] = a.args as [Address, bigint, `0x${string}`, number, string];
      expect(to).toBe(USDC); expect(op).toBe(0);
      const t = decodeFunctionData({ abi: erc20Abi, data });
      expect(t.functionName).toBe("transfer");
      const [dest, amount] = t.args as [Address, bigint];
      sent.push({ to: dest, amount, roleKey: key });
      await new Promise((r) => setTimeout(r, 5));
      balance += amount;
      return "0xhash";
    },
  };
  const publicClient = { readContract: async () => balance, waitForTransactionReceipt: async () => ({ status: "success" }) };
  return { agent, publicClient, sent };
}

describe("rolesFunder", () => {
  it("tops up to a tranche only when the payer can't cover the payment", async () => {
    const f = fakes(0n);
    const ensure = rolesFunder({ agent: f.agent as never, publicClient: f.publicClient as never, roles: ROLES, usdc: USDC, tranche: 40_000n });
    await ensure(payer, merchant, 10_000n);
    await ensure(payer, merchant, 10_000n);
    expect(f.sent).toEqual([{ to: payer.address, amount: 40_000n, roleKey: roleKey("agent-pay") }]);
  });

  it("serializes parallel payments for the same payer (no double top-up)", async () => {
    const f = fakes(0n);
    const ensure = rolesFunder({ agent: f.agent as never, publicClient: f.publicClient as never, roles: ROLES, usdc: USDC, tranche: 40_000n });
    await Promise.all([ensure(payer, merchant, 10_000n), ensure(payer, merchant, 10_000n), ensure(payer, merchant, 10_000n)]);
    expect(f.sent).toHaveLength(1);
  });

  it("refuses a payer outside the local allowlist without sending anything", async () => {
    const f = fakes(0n);
    const ensure = rolesFunder({ agent: f.agent as never, publicClient: f.publicClient as never, roles: ROLES, usdc: USDC, tranche: 40_000n, payers: ["0x4444444444444444444444444444444444444444"] });
    await expect(ensure(payer, merchant, 10_000n)).rejects.toThrow(/not in this role/);
    expect(f.sent).toHaveLength(0);
  });
});

describe("agentPayRoleCalls", () => {
  it("scopes USDC.transfer to the payers within an allowance, with conditions in breadth-first order", () => {
    const payers = ["0x5555555555555555555555555555555555555555", "0x6666666666666666666666666666666666666666"] as Address[];
    const calls = agentPayRoleCalls({ roles: ROLES, usdc: USDC, agent: payer.address, payers, dailyCap: 100_000n });
    const decoded = calls.map((c) => decodeFunctionData({ abi: ROLES_ABI, data: c.data }));
    expect(decoded.map((d) => d.functionName)).toEqual(["scopeTarget", "scopeFunction", "setAllowance", "assignRoles"]);
    const conditions = decoded[1]!.args![3] as unknown as { parent: number; paramType: number; operator: number }[];
    expect(conditions.map((c) => [c.parent, c.paramType, c.operator])).toEqual([[0, 5, 5], [0, 0, 2], [0, 1, 28], [1, 1, 16], [1, 1, 16]]);
    expect(decoded[1]!.args![4]).toBe(0); // no value, no delegatecall
    expect(decoded[2]!.args!.slice(1, 5)).toEqual([100_000n, 100_000n, 100_000n, 86_400n]);
  });

  it("rejects an empty payer list and out-of-range caps", () => {
    expect(() => agentPayRoleCalls({ roles: ROLES, usdc: USDC, agent: payer.address, payers: [], dailyCap: 1n })).toThrow();
    expect(() => agentPayRoleCalls({ roles: ROLES, usdc: USDC, agent: payer.address, payers: [payer.address], dailyCap: 0n })).toThrow();
  });
});
