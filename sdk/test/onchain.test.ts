import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  http,
  parseSignature,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { signExactAuthorization } from "../src/x402/exactEvm.js";
import { deriveBurnerKey } from "../src/wallet/burner.js";
import type { PinnedAsset } from "../src/policy/networks.js";

/**
 * End to end against a local chain: owner signs an intent, the agent funds a per-merchant burner from the
 * BudgetVault, the burner signs an x402 EIP-3009 authorization with the SDK, and a facilitator settles it on-chain.
 * Requires anvil (Foundry) and `forge build` in ../contracts; skipped otherwise.
 */
const ANVIL = [join(homedir(), ".foundry/bin/anvil"), "/usr/local/bin/anvil"].find(existsSync);
const OUT = join(__dirname, "../../contracts/out");
const canRun = ANVIL !== undefined && existsSync(join(OUT, "MockUSDC.sol/MockUSDC.json"));

function artifact(name: string): { abi: Abi; bytecode: Hex } {
  const a = JSON.parse(readFileSync(join(OUT, `${name}.sol/${name}.json`), "utf8"));
  return { abi: a.abi, bytecode: a.bytecode.object };
}

// Anvil's well-known dev keys.
const keys = {
  deployer: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  owner: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  agent: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  facilitator: "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
} as const;
const merchant: Address = "0x1111111111111111111111111111111111111111";
const PORT = 8546;

describe.skipIf(!canRun)("on-chain: BudgetVault + burner + EIP-3009", () => {
  let anvil: ChildProcess;
  const transport = http(`http://127.0.0.1:${PORT}`);
  const pub = createPublicClient({ chain: foundry, transport, pollingInterval: 50 });
  const test = createTestClient({ chain: foundry, transport, mode: "anvil" });
  const wallet = (k: Hex) => createWalletClient({ chain: foundry, transport, account: privateKeyToAccount(k) });

  beforeAll(async () => {
    anvil = spawn(ANVIL!, ["--port", String(PORT), "--silent"], { stdio: "ignore" });
    for (let i = 0; i < 50; i++) {
      try {
        await pub.getChainId();
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    throw new Error("anvil did not start");
  });
  afterAll(() => {
    anvil?.kill();
  });

  async function deploy(name: string, args: unknown[] = []): Promise<Address> {
    const { abi, bytecode } = artifact(name);
    const hash = await wallet(keys.deployer).deployContract({ abi, bytecode, args });
    return (await pub.waitForTransactionReceipt({ hash })).contractAddress!;
  }

  async function send(k: Hex, address: Address, name: string, functionName: string, args: unknown[]) {
    const hash = await wallet(k).writeContract({ address, abi: artifact(name).abi, functionName, args });
    const receipt = await pub.waitForTransactionReceipt({ hash });
    expect(receipt.status).toBe("success");
  }

  const read = (address: Address, name: string, functionName: string, args: unknown[] = []) =>
    pub.readContract({ address, abi: artifact(name).abi, functionName, args }) as Promise<any>;

  it("the agent pays a merchant through a burner, within the owner's signed budget", async () => {
    const owner = privateKeyToAccount(keys.owner);
    const agent = privateKeyToAccount(keys.agent);

    const usdc = await deploy("MockUSDC");
    const factory = await deploy("BudgetVaultFactory", [usdc, privateKeyToAccount(keys.facilitator).address, agent.address]);
    await send(keys.deployer, factory, "BudgetVaultFactory", "create", [owner.address, `0x${"00".repeat(32)}`, 3600]);
    const vault: Address = await read(factory, "BudgetVaultFactory", "predict", [owner.address, `0x${"00".repeat(32)}`, 3600]);
    await send(keys.deployer, usdc, "MockUSDC", "mint", [vault, 100_000_000n]);

    // 1. Owner signs an intent (EIP-712) off-chain; anyone can relay it.
    const now = Number((await pub.getBlock()).timestamp);
    const intent = {
      agent: agent.address,
      counterparty: merchant,
      token: usdc,
      maxPerTx: 5_000_000n,
      maxPerPeriod: 20_000_000n,
      trancheCap: 10_000_000n,
      period: 86_400,
      validAfter: 0n,
      expiry: BigInt(now + 30 * 86_400),
      nonce: 1n,
    };
    const signature = await owner.signTypedData({
      domain: { name: "Deep First Search Agent Safe", version: "1", chainId: foundry.id, verifyingContract: vault },
      types: {
        Intent: [
          { name: "agent", type: "address" },
          { name: "counterparty", type: "address" },
          { name: "token", type: "address" },
          { name: "maxPerTx", type: "uint128" },
          { name: "maxPerPeriod", type: "uint128" },
          { name: "trancheCap", type: "uint128" },
          { name: "period", type: "uint32" },
          { name: "validAfter", type: "uint64" },
          { name: "expiry", type: "uint64" },
          { name: "nonce", type: "uint256" },
        ],
      },
      primaryType: "Intent",
      message: intent,
    });
    await send(keys.agent, vault, "BudgetVault", "proposeIntent", [intent, signature]);
    const id: Hex = await read(vault, "BudgetVault", "intentId", [intent]);
    await test.increaseTime({ seconds: 3601 });
    await test.mine({ blocks: 1 });

    // 2. Agent funds the merchant's burner (derived by the SDK) from the vault.
    const burnerKey = deriveBurnerKey({ ownerSeed: new Uint8Array(32).fill(9), vault, chainId: foundry.id, counterparty: merchant });
    const burner = privateKeyToAccount(burnerKey);
    await send(keys.agent, vault, "BudgetVault", "fundBurner", [id, burner.address, 2_000_000n]);
    expect(await read(usdc, "MockUSDC", "balanceOf", [burner.address])).toBe(2_000_000n);

    // 3. Burner signs an x402 "exact" authorization with the SDK; a facilitator settles it.
    const asset: PinnedAsset = { network: "eip155:31337", chainId: foundry.id, asset: usdc, domain: { name: "USDC", version: "2" }, decimals: 6 };
    const ts = Number((await pub.getBlock()).timestamp);
    const auth = await signExactAuthorization({ account: burner, asset, to: merchant, value: 1_500_000n, validForSeconds: 60, nowSeconds: ts });
    await send(keys.facilitator, usdc, "MockUSDC", "transferWithAuthorization", [
      auth.authorization.from,
      auth.authorization.to,
      BigInt(auth.authorization.value),
      BigInt(auth.authorization.validAfter),
      BigInt(auth.authorization.validBefore),
      auth.authorization.nonce,
      auth.signature,
    ]);
    expect(await read(usdc, "MockUSDC", "balanceOf", [merchant])).toBe(1_500_000n);

    // 4. The 0.1% fee went 50/50 to the fee jar and ops.
    expect(await read(usdc, "MockUSDC", "balanceOf", [privateKeyToAccount(keys.facilitator).address])).toBe(1_000n);

    // 5. The agent cannot exceed the tranche cap, even though the period budget would allow it.
    await expect(
      wallet(keys.agent).writeContract({ address: vault, abi: artifact("BudgetVault").abi, functionName: "fundBurner", args: [id, burner.address, 9_600_000n] }),
    ).rejects.toThrow();
    expect(parseSignature(auth.signature).r).toMatch(/^0x/);
  });
});
