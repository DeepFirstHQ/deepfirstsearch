import { describe, expect, it } from "vitest";
import { decodeFunctionData, erc20Abi, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { BaseError, ContractFunctionRevertedError, encodeErrorResult, slice, hexToNumber, size } from "viem";
import { PaymentDeniedError } from "@deepfirstsearch/agent-pay";
import {
  accrue, agentAllowanceKey, agentPayRoleCalls, batchCalls, budgetKey, freezeCalls, revokeAgentCalls, rolesFunder, roleKey,
  teamBudgetCalls, ledgerCsv, ROLES_ABI,
} from "../src/index.js";

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

describe("company helpers", () => {
  const payers = ["0x5555555555555555555555555555555555555555", "0x6666666666666666666666666666666666666666"] as Address[];
  const decode = (data: `0x${string}`) => decodeFunctionData({ abi: ROLES_ABI, data });

  it("a team budget puts both allowances under an And on the amount, after the payers (breadth-first)", () => {
    const calls = agentPayRoleCalls({ roles: ROLES, usdc: USDC, agent: payer.address, payers, cap: 60_000n, budget: "research", role: "r1" });
    const conditions = decode(calls[1]!.data).args![3] as unknown as { parent: number; paramType: number; operator: number; compValue: string }[];
    expect(conditions.map((c) => [c.parent, c.paramType, c.operator])).toEqual([[0, 5, 5], [0, 0, 2], [0, 0, 1], [1, 1, 16], [1, 1, 16], [2, 1, 28], [2, 1, 28]]);
    expect(conditions.slice(5).map((c) => c.compValue)).toEqual([agentAllowanceKey("r1"), budgetKey("research")]);
  });

  it("cap, period and the deprecated dailyCap", () => {
    const monthly = agentPayRoleCalls({ roles: ROLES, usdc: USDC, agent: payer.address, payers, cap: 5n, period: 2_592_000 });
    expect(decode(monthly[2]!.data).args!.slice(1, 5)).toEqual([5n, 5n, 5n, 2_592_000n]);
    expect(() => agentPayRoleCalls({ roles: ROLES, usdc: USDC, agent: payer.address, payers, cap: 5n, dailyCap: 6n })).toThrow(/disagree/);
    expect(() => agentPayRoleCalls({ roles: ROLES, usdc: USDC, agent: payer.address, payers, cap: 5n, period: 0 })).toThrow(/period/);
    expect(() => agentPayRoleCalls({ roles: ROLES, usdc: USDC, agent: payer.address, payers })).toThrow(/cap/);
  });

  it("team budget, freeze and revoke calls", () => {
    expect(decode(teamBudgetCalls({ roles: ROLES, budget: "research", cap: 100n })[0]!.data).args).toEqual([budgetKey("research"), 100n, 100n, 100n, 86_400n, 0n]);
    expect(decode(freezeCalls({ roles: ROLES, budget: "research" })[0]!.data).args!.slice(0, 4)).toEqual([budgetKey("research"), 0n, 0n, 0n]);
    expect(decode(freezeCalls({ roles: ROLES, role: "r1" })[0]!.data).args![0]).toBe(agentAllowanceKey("r1"));
    expect(decode(revokeAgentCalls({ roles: ROLES, agent: payer.address, role: "r1" })[0]!.data).args).toEqual([payer.address, [roleKey("r1")], [false]]);
  });

  it("batchCalls packs plain calls for MultiSendCallOnly (delegatecall)", () => {
    const calls = teamBudgetCalls({ roles: ROLES, budget: "a", cap: 1n }).concat(revokeAgentCalls({ roles: ROLES, agent: payer.address }));
    const b = batchCalls(calls, "0x9641d764fc13c8B624c04430C7356C1C7C8102e2");
    expect(b.operation).toBe(1);
    const packed = decodeFunctionData({ abi: [{ type: "function", name: "multiSend", stateMutability: "payable", inputs: [{ name: "transactions", type: "bytes" }], outputs: [] }], data: b.data }).args[0];
    let at = 0;
    for (const c of calls) {
      expect(hexToNumber(slice(packed, at, at + 1))).toBe(0); // Call, never DelegateCall
      expect(slice(packed, at + 1, at + 21).toLowerCase()).toBe(c.to.toLowerCase());
      const len = hexToNumber(slice(packed, at + 53, at + 85));
      expect(slice(packed, at + 85, at + 85 + len)).toBe(c.data);
      at += 85 + len;
    }
    expect(at).toBe(size(packed));
    expect(() => batchCalls([], ROLES)).toThrow();
  });

  it("accrue follows Roles: refills per elapsed period, capped, and frozen never refills", () => {
    const a = { refill: 100n, maxRefill: 100n, period: 86_400n, balance: 30n, timestamp: 1_000n };
    expect(accrue(a, 1_000n + 86_399n)).toEqual({ available: 30n, cap: 100n, period: 86_400, nextRefillAt: 1_000 + 86_400 });
    expect(accrue(a, 1_000n + 86_400n * 3n + 5n)).toEqual({ available: 100n, cap: 100n, period: 86_400, nextRefillAt: 1_000 + 86_400 * 4 });
    expect(accrue({ ...a, refill: 0n, maxRefill: 0n, balance: 0n }, 10n ** 9n)).toMatchObject({ available: 0n, nextRefillAt: null });
  });

  it("maps Roles refusals to SDK refusal codes, and sends nothing else", async () => {
    const revert = (errorName: "ConditionViolation" | "NoMembership", args: readonly unknown[]) => {
      const data = encodeErrorResult({ abi: ROLES_ABI, errorName, args: args as never });
      const inner = new ContractFunctionRevertedError({ abi: ROLES_ABI as never, data, functionName: "execTransactionWithRole" });
      return new BaseError("reverted", { cause: inner });
    };
    const failing = (err: unknown) => ({
      agent: { account: { address: payer.address }, chain: undefined, writeContract: async () => { throw err; } },
      publicClient: { readContract: async () => 0n, waitForTransactionReceipt: async () => ({ status: "success" }) },
    });
    const run = (err: unknown) => {
      const f = failing(err);
      return rolesFunder({ agent: f.agent as never, publicClient: f.publicClient as never, roles: ROLES, usdc: USDC, tranche: 1n })(payer, merchant, 1n);
    };
    const over = await run(revert("ConditionViolation", [17, "0x" + "0".repeat(64)])).catch((e) => e);
    expect(over).toBeInstanceOf(PaymentDeniedError);
    expect([over.code, over.reasons[0]]).toEqual(["budget_exhausted", "Zodiac Roles refused the top-up: AllowanceExceeded"]);
    const notPayer = await run(revert("ConditionViolation", [7, "0x" + "0".repeat(64)])).catch((e) => e);
    expect([notPayer.code, notPayer.reasons[0]]).toEqual(["policy_denied", "Zodiac Roles refused the top-up: ParameterNotAllowed"]);
    const revoked = await run(revert("NoMembership", [])).catch((e) => e);
    expect(revoked.code).toBe("policy_denied");
    const network = new Error("socket hang up");
    expect(await run(network).catch((e) => e)).toBe(network); // anything else is passed through unchanged
  });
});

describe("ledgerCsv", () => {
  it("writes RFC 4180 rows with USDC amounts, quoting and formula protection", () => {
    const row = {
      date: "2026-10-14T16:00:00.000Z", block: 123n, tx: `0x${"ab".repeat(32)}` as `0x${string}`, logIndex: 0, type: "payment" as const,
      from: "0x1111111111111111111111111111111111111111" as Address, to: "0x2222222222222222222222222222222222222222" as Address,
    };
    const csv = ledgerCsv([
      { ...row, label: "research / r1, data", amount: 10_000n, site: "https://api.example" },
      { ...row, type: "top-up", label: '=HYPERLINK("x")', amount: 1_234_567_890n },
    ]);
    expect(csv.split("\r\n")).toEqual([
      "date,block,tx_hash,type,label,from,to,amount_usdc,site",
      `2026-10-14T16:00:00.000Z,123,0x${"ab".repeat(32)},payment,"research / r1, data",${row.from},${row.to},0.010000,https://api.example`,
      `2026-10-14T16:00:00.000Z,123,0x${"ab".repeat(32)},top-up,"'=HYPERLINK(""x"")",${row.from},${row.to},1234.567890,`,
      "",
    ]);
  });
});
