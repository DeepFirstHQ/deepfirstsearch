import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPublicClient, createTestClient, createWalletClient, http, publicActions, type Abi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import {
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
} from "@x402/core/http";
import { PaymentPayloadV2Schema, PaymentRequiredV2Schema } from "@x402/core/schemas";
import { ExactEvmScheme } from "@x402/evm/exact/facilitator";
import { toFacilitatorEvmSigner } from "@x402/evm";
import { createAgentPay } from "../src/x402/client.js";
import { MerchantRegistry } from "../src/policy/registry.js";
import { encodeHeader } from "../src/x402/codec.js";
import type { PinnedAsset } from "../src/policy/networks.js";
import { vaultFunder } from "../src/wallet/vault.js";
import { burnerPayers, burnerAddress } from "../src/wallet/burner.js";
import { signIntent } from "../src/wallet/intent.js";

/**
 * Conformance against the official x402 v2 packages (@x402/core, @x402/evm by the x402 Foundation):
 * a resource server built with the official header codecs, and the official "exact" EVM facilitator verifying
 * and settling, on-chain, what our SDK signs. Requires anvil and ../contracts/out; skipped otherwise.
 */
const ANVIL = [join(homedir(), ".foundry/bin/anvil"), "/usr/local/bin/anvil"].find(existsSync);
const OUT = join(__dirname, "../../contracts/out/MockUSDC.sol/MockUSDC.json");
const artifact = (name: string) => JSON.parse(readFileSync(join(__dirname, `../../contracts/out/${name}.sol/${name}.json`), "utf8"));
const canRun = ANVIL !== undefined && existsSync(OUT);

const PORT = 8547;
const NETWORK = "eip155:31337";
const keys = {
  deployer: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  payer: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  facilitator: "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  owner: "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
  agent: "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
} as const;
const MERCHANT: Address = "0x1111111111111111111111111111111111111111";

describe.skipIf(!canRun)("conformance with official x402 v2 packages", () => {
  let anvil: ChildProcess;
  let server: Server;
  let serverUrl = "";
  let usdc: Address;
  const received: unknown[] = [];
  const transport = http(`http://127.0.0.1:${PORT}`);
  const pub = createPublicClient({ chain: foundry, transport, pollingInterval: 50 });

  beforeAll(async () => {
    anvil = spawn(ANVIL!, ["--port", String(PORT), "--silent"], { stdio: "ignore" });
    for (let i = 0; i < 50; i++) {
      try {
        await pub.getChainId();
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    const artifact = JSON.parse(readFileSync(OUT, "utf8"));
    const deployer = createWalletClient({ chain: foundry, transport, account: privateKeyToAccount(keys.deployer) });
    const hash = await deployer.deployContract({ abi: artifact.abi as Abi, bytecode: artifact.bytecode.object as Hex });
    usdc = (await pub.waitForTransactionReceipt({ hash })).contractAddress!;
    const mint = await deployer.writeContract({
      address: usdc,
      abi: artifact.abi as Abi,
      functionName: "mint",
      args: [privateKeyToAccount(keys.payer).address, 10_000_000n],
    });
    await pub.waitForTransactionReceipt({ hash: mint });

    // The official facilitator, wired to a funded local account.
    const facilitatorAccount = privateKeyToAccount(keys.facilitator);
    const facilitatorClient = createWalletClient({ chain: foundry, transport, account: facilitatorAccount }).extend(publicActions);
    const facilitator = new ExactEvmScheme(
      toFacilitatorEvmSigner({ ...facilitatorClient, address: facilitatorAccount.address } as never),
    );

    const requirement = {
      scheme: "exact",
      network: NETWORK,
      amount: "10000",
      asset: usdc,
      payTo: MERCHANT,
      maxTimeoutSeconds: 60,
      extra: { name: "USDC", version: "2", assetTransferMethod: "eip3009" },
    };

    server = createServer(async (req, res) => {
      const sig = req.headers["payment-signature"];
      if (typeof sig !== "string") {
        const required = { x402Version: 2, resource: { url: `${serverUrl}${req.url}` }, accepts: [requirement] };
        expect(PaymentRequiredV2Schema.safeParse(required).success).toBe(true);
        res.writeHead(402, { "PAYMENT-REQUIRED": encodePaymentRequiredHeader(required as never) }).end();
        return;
      }
      try {
        const payload = decodePaymentSignatureHeader(sig);
        received.push(payload);
        const verified = await facilitator.verify(payload as never, requirement as never);
        if (!verified.isValid) {
          res.writeHead(402, { "x-verify-error": encodeURIComponent(String(verified.invalidReason)) }).end();
          return;
        }
        const settled = await facilitator.settle(payload as never, requirement as never);
        res.writeHead(settled.success ? 200 : 402, { "PAYMENT-RESPONSE": encodePaymentResponseHeader(settled) }).end("ok");
      } catch (e) {
        res.writeHead(500, { "x-error": String(e).slice(0, 200) }).end();
      }
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    serverUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }, 60_000);

  afterAll(async () => {
    await new Promise((r) => server?.close(r));
    anvil?.kill();
  });

  it("our signed payload passes the official schema, verify and on-chain settle", async () => {
    const local: PinnedAsset = { network: NETWORK, chainId: foundry.id, asset: usdc, domain: { name: "USDC", version: "2" }, decimals: 6 };
    const registry = new MerchantRegistry([{ origin: serverUrl, payTo: MERCHANT, network: NETWORK, maxPerTx: 50_000n, pricePin: 10_000n }]);
    const pay = createAgentPay({
      registry,
      policy: { allowedNetworks: [NETWORK], assets: { [NETWORK]: local } },
      payer: () => privateKeyToAccount(keys.payer),
      session: { readsUntrustedInput: false, accessesSensitiveData: false, canPay: true },
    });
    const plan = pay.commitPlan([{ origin: serverUrl, maxSpend: 100_000n }], 60_000);

    const res = await pay.fetch(`${serverUrl}/data`, {}, { plan });
    expect(res.headers.get("x-verify-error")).toBeNull();
    expect(res.headers.get("x-error")).toBeNull();
    expect(res.status).toBe(200);
    expect(res.payment?.settlement.success).toBe(true);
    expect(res.payment?.settlement.transaction).toMatch(/^0x[0-9a-f]{64}$/);

    // The official schema accepts exactly what we sent.
    expect(PaymentPayloadV2Schema.safeParse(received[0]).success).toBe(true);

    const balance = await pub.readContract({
      address: usdc,
      abi: [{ type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] }],
      functionName: "balanceOf",
      args: [MERCHANT],
    });
    expect(balance).toBe(10_000n);
  });

  it("full loop: owner intent, SDK funds the merchant's burner from the vault, official facilitator settles", async () => {
    const owner = privateKeyToAccount(keys.owner);
    const agent = privateKeyToAccount(keys.agent);
    const deployer = createWalletClient({ chain: foundry, transport, account: privateKeyToAccount(keys.deployer) });
    const send = async (hash: Hex) => expect((await pub.waitForTransactionReceipt({ hash })).status).toBe("success");

    const f = artifact("BudgetVaultFactory");
    const factoryHash = await deployer.deployContract({ abi: f.abi, bytecode: f.bytecode.object, args: [usdc, "0x2222222222222222222222222222222222222222", "0x3333333333333333333333333333333333333333"] });
    const factory = (await pub.waitForTransactionReceipt({ hash: factoryHash })).contractAddress!;
    const salt = `0x${"01".repeat(32)}` as Hex;
    await send(await deployer.writeContract({ address: factory, abi: f.abi, functionName: "create", args: [owner.address, salt, 3600] }));
    const vault = (await pub.readContract({ address: factory, abi: f.abi, functionName: "predict", args: [owner.address, salt, 3600] })) as Address;
    const usdcAbi = JSON.parse(readFileSync(OUT, "utf8")).abi as Abi;
    await send(await deployer.writeContract({ address: usdc, abi: usdcAbi, functionName: "mint", args: [vault, 5_000_000n] }));

    // Facilitators check validity windows against wall-clock time, so the chain must agree with it. Rewind the
    // chain clock by the timelock before proposing, then move it to "now" so the intent is active and in sync.
    const anvilRpc = createTestClient({ chain: foundry, transport, mode: "anvil" });
    const setTime = async (t: number) => {
      await anvilRpc.request({ method: "evm_setTime", params: [t] } as never);
      await anvilRpc.mine({ blocks: 1 });
    };
    const wall = () => Math.floor(Date.now() / 1000);
    await setTime(wall() - 3_700);
    const now = Number((await pub.getBlock()).timestamp);
    const intent = {
      agent: agent.address, counterparty: MERCHANT,
      burner: burnerAddress({ ownerSeed: new Uint8Array(32).fill(3), vault, chainId: foundry.id, counterparty: MERCHANT }), token: usdc, maxPerTx: 100_000n, maxPerPeriod: 1_000_000n,
      trancheCap: 200_000n, period: 86_400, validAfter: 0n, expiry: BigInt(now + 86_400 * 30), nonce: 7n,
    };
    const signature = await signIntent(owner, vault, foundry.id, intent);
    const v = artifact("BudgetVault");
    await send(await deployer.writeContract({ address: vault, abi: v.abi, functionName: "proposeIntent", args: [intent, signature] }));
    const intentId = (await pub.readContract({ address: vault, abi: v.abi, functionName: "intentId", args: [intent] })) as Hex;
    await setTime(wall());

    const suffix = "0xdeadbeef80218021" as Hex;
    const local: PinnedAsset = { network: NETWORK, chainId: foundry.id, asset: usdc, domain: { name: "USDC", version: "2" }, decimals: 6 };
    const pay = createAgentPay({
      registry: new MerchantRegistry([{ origin: serverUrl, payTo: MERCHANT, network: NETWORK, maxPerTx: 50_000n, pricePin: 10_000n }]),
      policy: { allowedNetworks: [NETWORK], assets: { [NETWORK]: local } },
      payer: burnerPayers(new Uint8Array(32).fill(3), vault),
      session: { readsUntrustedInput: false, accessesSensitiveData: false, canPay: true },
      ensureFunded: vaultFunder({
        agent: createWalletClient({ chain: foundry, transport, account: agent }),
        publicClient: pub, vault, usdc, intents: { [MERCHANT]: intentId }, tranche: 50_000n, dataSuffix: suffix, confirmations: 1,
      }),
    });
    const plan = pay.commitPlan([{ origin: serverUrl, maxSpend: 100_000n }], 60_000);
    const bal = (a: Address) => pub.readContract({ address: usdc, abi: usdcAbi, functionName: "balanceOf", args: [a] }) as Promise<bigint>;
    const JAR: Address = "0x2222222222222222222222222222222222222222";
    const OPS: Address = "0x3333333333333333333333333333333333333333";
    const before = await bal(MERCHANT);
    const feesBefore = (await bal(JAR)) + (await bal(OPS));
    const res = await pay.fetch(`${serverUrl}/data`, {}, { plan });
    expect(res.status).toBe(200);
    const after = await pub.readContract({ address: usdc, abi: usdcAbi, functionName: "balanceOf", args: [MERCHANT] }) as bigint;
    // The merchant got exactly the payment; the vault's fee on the funded tranche went to the jar and ops.
    expect(after - before).toBe(10_000n);
    expect((await bal(JAR)) + (await bal(OPS)) - feesBefore).toBe(50n);

    // The funding transaction carries the Builder Code attribution suffix.
    const logs = await pub.getContractEvents({ address: vault, abi: v.abi, eventName: "BurnerFunded", fromBlock: 0n });
    const tx = await pub.getTransaction({ hash: logs.at(-1)!.transactionHash! });
    expect(tx.input.endsWith(suffix.slice(2))).toBe(true);
  });

  it("our header encoding round-trips through the official decoder", () => {
    const sample = {
      x402Version: 2,
      accepted: {
        scheme: "exact",
        network: NETWORK,
        amount: "1",
        asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        payTo: MERCHANT,
        maxTimeoutSeconds: 60,
      },
      payload: {
        signature: `0x${"11".repeat(65)}`,
        authorization: {
          from: MERCHANT,
          to: MERCHANT,
          value: "1",
          validAfter: "0",
          validBefore: "9999999999",
          nonce: `0x${"22".repeat(32)}`,
        },
      },
    };
    expect(decodePaymentSignatureHeader(encodeHeader(sample))).toEqual(sample);
  });
});
