import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPublicClient, createTestClient, createWalletClient, http, type Abi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { ownerCli } from "../src/cli/owner.js";
import { decryptKeystore } from "../src/cli/keystore.js";
import { burnerAddress } from "../src/wallet/burner.js";
import { hexToBytes } from "viem";

// Foundry binaries: ~/.foundry/bin locally, anywhere on PATH in CI.
const BIN = [join(homedir(), ".foundry/bin"), ...(process.env.PATH ?? "").split(":")].find((d) => d && existsSync(join(d, "anvil")) && existsSync(join(d, "cast"))) ?? "";
const OUT = join(__dirname, "../../contracts/out");
const canRun = BIN !== "" && existsSync(join(OUT, "MockUSDC.sol/MockUSDC.json"));
const PORT = 8548;
const RPC = `http://127.0.0.1:${PORT}`;
const keys = {
  deployer: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  owner: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  agent: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  stranger: "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
} as const;
const MERCHANT: Address = "0x1111111111111111111111111111111111111111";
const SEED = `0x${"42".repeat(32)}` as Hex;
const artifact = (n: string) => JSON.parse(readFileSync(join(OUT, `${n}.sol/${n}.json`), "utf8")) as { abi: Abi; bytecode: { object: Hex } };

describe.skipIf(!canRun)("agent-pay owner CLI (anvil)", () => {
  let anvil: ChildProcess;
  const transport = http(RPC);
  const pub = createPublicClient({ chain: foundry, transport, pollingInterval: 50 });
  const test = createTestClient({ chain: foundry, transport, mode: "anvil" });
  const wallet = (k: Hex) => createWalletClient({ chain: foundry, transport, account: privateKeyToAccount(k) });
  let usdc: Address, factory: Address, vault: Address, intentId: Hex;
  const home = mkdtempSync(join(tmpdir(), "agent-pay-cli-"));

  async function cli(args: string[], env: Record<string, string> = {}) {
    const out: string[] = [], err: string[] = [];
    let code: number;
    try {
      code = await ownerCli([...args, "--rpc", RPC, "--factory", factory, "--usdc", usdc, "--json"], { AGENT_PAY_HOME: home, AGENT_PAY_OWNER_KEY: keys.owner, AGENT_PAY_BURNER_SEED: SEED, ...env }, { out: (s) => out.push(s), err: (s) => err.push(s) });
    } catch (e) {
      return { code: 1, json: undefined as any, err: [...err, (e as Error).message].join("\n") };
    }
    return { code, json: out.length ? JSON.parse(out.join("")) : undefined, err: err.join("\n") };
  }
  const deploy = async (n: string, args: unknown[] = []) => {
    const a = artifact(n);
    const hash = await wallet(keys.deployer).deployContract({ abi: a.abi, bytecode: a.bytecode.object, args });
    return (await pub.waitForTransactionReceipt({ hash })).contractAddress!;
  };
  const bal = (a: Address) => pub.readContract({ address: usdc, abi: artifact("MockUSDC").abi, functionName: "balanceOf", args: [a] }) as Promise<bigint>;

  beforeAll(async () => {
    anvil = spawn(join(BIN, "anvil"), ["--port", String(PORT), "--silent"], { stdio: "ignore" });
    for (let i = 0; i < 50; i++) {
      try { await pub.getChainId(); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
    }
    usdc = await deploy("MockUSDC");
    factory = await deploy("BudgetVaultFactory", [usdc, "0x2222222222222222222222222222222222222222", "0x3333333333333333333333333333333333333333"]);
    const hash = await wallet(keys.deployer).writeContract({ address: usdc, abi: artifact("MockUSDC").abi, functionName: "mint", args: [privateKeyToAccount(keys.owner).address, 5_000_000n] });
    await pub.waitForTransactionReceipt({ hash });
  });
  afterAll(() => anvil?.kill());

  it("refuses to send without --yes when not interactive", async () => {
    const r = await cli(["create-vault"]);
    expect(r.err).toMatch(/pass --yes/);
  });

  it("creates the vault, idempotently", async () => {
    const r = await cli(["create-vault", "--yes"]);
    expect(r.json.created).toBe(true);
    vault = r.json.vault;
    expect(await pub.getCode({ address: vault })).toBeDefined();
    expect((await cli(["create-vault", "--yes"])).json).toMatchObject({ vault, created: false });
  });

  it("funds it", async () => {
    await cli(["fund", "--vault", vault, "--amount", "1.00", "--yes"]);
    expect(await bal(vault)).toBe(1_000_000n);
  });

  it("rejects bad budgets before signing anything", async () => {
    const agent = privateKeyToAccount(keys.agent).address;
    expect((await cli(["budget", "--vault", vault, "--merchant", MERCHANT, "--agent", agent, "--per-tx", "0.50", "--per-day", "0.20", "--yes"])).err).toMatch(/cannot exceed/);
    expect((await cli(["budget", "--vault", vault, "--merchant", MERCHANT, "--agent", agent, "--per-tx", "1e-2", "--per-day", "0.20", "--yes"])).err).toMatch(/USDC amount/);
    expect((await cli(["budget", "--vault", vault, "--merchant", MERCHANT, "--agent", agent, "--per-tx", "0.05", "--per-day", "0.20", "--yes"], { AGENT_PAY_OWNER_KEY: keys.stranger })).err).toMatch(/not this vault's owner/);
  });

  it("signs and proposes a budget whose payer matches the agent's seed, pending until the timelock", async () => {
    const agent = privateKeyToAccount(keys.agent).address;
    const r = await cli(["budget", "--vault", vault, "--merchant", MERCHANT, "--agent", agent, "--per-tx", "0.05", "--per-day", "0.20", "--yes"]);
    expect(r.code).toBe(0);
    intentId = r.json.intentId;
    expect(r.json.burner).toBe(burnerAddress({ ownerSeed: hexToBytes(SEED), vault, chainId: 31337, counterparty: MERCHANT }));
    const s = await cli(["status", "--vault", vault]);
    expect(s.json.intents).toHaveLength(1);
    expect(s.json.intents[0].state).toMatch(/^pending until/);
  });

  it("status follows the on-chain spend once active", async () => {
    await test.increaseTime({ seconds: 3601 });
    await test.mine({ blocks: 1 });
    const burner = (await cli(["status", "--vault", vault])).json.intents[0].payer as Address;
    const hash = await wallet(keys.agent).writeContract({ address: vault, abi: artifact("BudgetVault").abi, functionName: "fundBurner", args: [intentId, burner, 50_000n] });
    expect((await pub.waitForTransactionReceipt({ hash })).status).toBe("success");
    const s = (await cli(["status", "--vault", vault])).json;
    expect(s.intents[0]).toMatchObject({ state: "active", spentThisPeriod: "50000", payerBalance: "50000" });
    expect(s.balance).toBe(String(1_000_000n - 50_000n - 50n));
  });

  it("pauses, revokes and withdraws", async () => {
    await cli(["pause", "--vault", vault, "--yes"]);
    expect((await cli(["status", "--vault", vault])).json.paused).toBe(true);
    await cli(["unpause", "--vault", vault, "--yes"]);
    await cli(["revoke", "--vault", vault, "--intent", intentId, "--yes"]);
    expect((await cli(["status", "--vault", vault])).json.intents[0].state).toBe("revoked");
    const owner = privateKeyToAccount(keys.owner).address;
    const before = await bal(owner);
    await cli(["withdraw", "--vault", vault, "--amount", "0.5", "--yes"]);
    expect((await bal(owner)) - before).toBe(500_000n);
  });

  it("reads Foundry keystores, and rejects a wrong password", () => {
    const dir = mkdtempSync(join(tmpdir(), "ks-"));
    execFileSync(join(BIN, "cast"), ["wallet", "new", dir, "k", "--unsafe-password", "pw"], { stdio: "ignore" });
    const file = join(dir, "k");
    const expected = execFileSync(join(BIN, "cast"), ["wallet", "address", "--keystore", file, "--password", "pw"]).toString().trim();
    expect(privateKeyToAccount(decryptKeystore(file, "pw")).address).toBe(expected);
    expect(() => decryptKeystore(file, "nope")).toThrow(/wrong keystore password/);
  });
});
