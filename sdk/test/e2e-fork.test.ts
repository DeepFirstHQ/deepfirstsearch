import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  encodeAbiParameters,
  http,
  keccak256,
  publicActions,
  toHex,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader, encodePaymentResponseHeader } from "@x402/core/http";
import { ExactEvmScheme } from "@x402/evm/exact/facilitator";
import { toFacilitatorEvmSigner } from "@x402/evm";
import { createAgentPay } from "../src/x402/client.js";
import { MerchantRegistry } from "../src/policy/registry.js";
import { vaultFunder } from "../src/wallet/vault.js";
import { burnerAddress, burnerPayers, deriveBurnerKey } from "../src/wallet/burner.js";
import { signIntent } from "../src/wallet/intent.js";
import { PINNED_USDC } from "../src/policy/networks.js";

/**
 * End-to-end lifecycle on a fork of Base mainnet: Circle's real USDC (FiatToken v2.2, domain "USD Coin" v2), the SDK's
 * production network pins, the v0.3 contracts and the official x402 "exact" facilitator settling on-chain.
 * Requires anvil, ../contracts/out and BASE_FORK_RPC (e.g. https://mainnet.base.org); skipped otherwise.
 */
const ANVIL = [join(homedir(), ".foundry/bin/anvil"), "/usr/local/bin/anvil"].find(existsSync);
const FORK = process.env.BASE_FORK_RPC;
const art = (name: string) => JSON.parse(readFileSync(join(__dirname, `../../contracts/out/${name}.sol/${name}.json`), "utf8"));
const canRun = ANVIL !== undefined && !!FORK && existsSync(join(__dirname, "../../contracts/out/BudgetVault.sol/BudgetVault.json"));

const PORT = 8553;
const NETWORK = "eip155:8453";
const USDC = PINNED_USDC[NETWORK]!.asset;
const USDC_BALANCE_SLOT = 9n; // FiatToken v2.2 balanceAndBlacklistStates
const PRICE = 10_000n; // 0.01 USDC
const TRANCHE = 40_000n;
const usdcAbi = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "v", type: "uint256" }], outputs: [{ type: "bool" }] },
] as const;

describe.skipIf(!canRun)("e2e on a Base mainnet fork: real USDC, v0.3 contracts, SDK, official facilitator", () => {
  let anvil: ChildProcess;
  let server: Server;
  let url = "";
  const signaturesSeen: unknown[] = [];
  const transport = http(`http://127.0.0.1:${PORT}`);
  const pub = createPublicClient({ chain: base, transport, pollingInterval: 50 });
  const test = createTestClient({ chain: base, transport, mode: "anvil" });
  const key = () => privateKeyToAccount(generatePrivateKey());
  const [deployer, owner, agent, ops, facilitatorAcct, attacker] = [key(), key(), key(), key(), key(), key()];
  const merchant = key().address;
  const seed = new Uint8Array(32).fill(7);
  let vault: Address, jar: Address, factory: Address, intentId: Hex, burner: Address;
  const V = art("BudgetVault").abi as Abi;
  const F = art("BudgetVaultFactory").abi as Abi;

  const bal = (a: Address) => pub.readContract({ address: USDC, abi: usdcAbi, functionName: "balanceOf", args: [a] });
  const ok = async (hash: Hex) => expect((await pub.waitForTransactionReceipt({ hash })).status).toBe("success");
  const wallet = (acct: ReturnType<typeof key>) => createWalletClient({ chain: base, transport, account: acct });
  const chainNow = async () => Number((await pub.getBlock()).timestamp);

  beforeAll(async () => {
    anvil = spawn(ANVIL!, ["--fork-url", FORK!, "--port", String(PORT), "--silent"], { stdio: "ignore" });
    for (let i = 0; i < 100; i++) {
      try { await pub.getChainId(); break; } catch { await new Promise((r) => setTimeout(r, 150)); }
    }
    for (const a of [deployer, owner, agent, facilitatorAcct, attacker]) await test.setBalance({ address: a.address, value: 10n ** 18n });
    // Give the owner 10 real USDC by writing its FiatToken balance slot.
    const slot = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [owner.address, USDC_BALANCE_SLOT]));
    await test.setStorageAt({ address: USDC, index: slot, value: toHex(10_000_000n, { size: 32 }) });
    expect(await bal(owner.address)).toBe(10_000_000n);

    const d = wallet(deployer);
    const jarArt = art("FeeJar");
    jar = (await pub.waitForTransactionReceipt({ hash: await d.deployContract({ abi: jarArt.abi, bytecode: jarArt.bytecode.object, args: [deployer.address] }) })).contractAddress!;
    const fArt = art("BudgetVaultFactory");
    factory = (await pub.waitForTransactionReceipt({ hash: await d.deployContract({ abi: fArt.abi, bytecode: fArt.bytecode.object, args: [USDC, jar, ops.address] }) })).contractAddress!;

    // A minimal x402 resource server built with the official codecs and facilitator.
    const facilitatorClient = wallet(facilitatorAcct).extend(publicActions);
    const facilitator = new ExactEvmScheme(toFacilitatorEvmSigner({ ...facilitatorClient, address: facilitatorAcct.address } as never));
    const requirementFor = (path: string) => ({
      scheme: "exact",
      network: NETWORK,
      amount: path === "/pricey" ? "60000" : String(PRICE),
      asset: USDC,
      payTo: path === "/evil" ? attacker.address : merchant,
      // The test advances the chain clock past two vault timelocks; a 4-hour window keeps wall clock and chain in range.
      maxTimeoutSeconds: 14_400,
      extra: { name: "USD Coin", version: "2", assetTransferMethod: "eip3009" },
    });
    server = createServer(async (req, res) => {
      const requirement = requirementFor(req.url ?? "/");
      const sig = req.headers["payment-signature"];
      if (typeof sig !== "string") {
        res.writeHead(402, { "PAYMENT-REQUIRED": encodePaymentRequiredHeader({ x402Version: 2, resource: { url: `${url}${req.url}` }, accepts: [requirement] } as never) }).end();
        return;
      }
      try {
        const payload = decodePaymentSignatureHeader(sig);
        signaturesSeen.push({ path: req.url, payload });
        const v = await facilitator.verify(payload as never, requirement as never);
        if (!v.isValid) return void res.writeHead(402, { "x-verify-error": String(v.invalidReason) }).end();
        const s = await facilitator.settle(payload as never, requirement as never);
        res.writeHead(s.success ? 200 : 402, { "PAYMENT-RESPONSE": encodePaymentResponseHeader(s) }).end("premium");
      } catch (e) {
        res.writeHead(500, { "x-error": String(e).slice(0, 200) }).end();
      }
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }, 120_000);

  afterAll(async () => {
    await new Promise((r) => server?.close(r));
    anvil?.kill();
  });

  const makePay = () =>
    createAgentPay({
      registry: new MerchantRegistry([{ origin: url, payTo: merchant, network: NETWORK, maxPerTx: 50_000n, pricePin: PRICE }]),
      policy: { allowedNetworks: [NETWORK], timeoutBounds: { min: 10, max: 14_400 } },
      payer: burnerPayers(seed, vault),
      session: { readsUntrustedInput: true, accessesSensitiveData: false, canPay: true },
      ensureFunded: vaultFunder({
        agent: wallet(agent), publicClient: pub as never, vault, usdc: USDC, intents: { [merchant]: intentId }, tranche: TRANCHE, confirmations: 1,
      }),
    });
  const payOnce = async (path = "/data") => {
    const pay = makePay();
    const plan = pay.commitPlan([{ origin: url, maxSpend: 100_000n }], 600_000);
    return pay.fetch(`${url}${path}`, {}, { plan });
  };

  it("1. anyone creates the owner's vault; create is idempotent; the owner funds it", async () => {
    const salt = `0x${"0d".repeat(32)}` as Hex;
    vault = (await pub.readContract({ address: factory, abi: F, functionName: "predict", args: [owner.address, salt, 3600] })) as Address;
    await ok(await wallet(attacker).writeContract({ address: factory, abi: F, functionName: "create", args: [owner.address, salt, 3600] }));
    await ok(await wallet(owner).writeContract({ address: factory, abi: F, functionName: "create", args: [owner.address, salt, 3600] }));
    expect(await pub.readContract({ address: vault, abi: V, functionName: "OWNER" })).toBe(owner.address);
    await ok(await wallet(owner).writeContract({ address: USDC, abi: usdcAbi, functionName: "transfer", args: [vault, 5_000_000n] }));
    expect(await bal(vault)).toBe(5_000_000n);
  });

  it("2. the owner signs a budget (SDK helper); anyone relays it; it is timelocked", async () => {
    burner = burnerAddress({ ownerSeed: seed, vault, chainId: 8453, counterparty: merchant });
    const intent = {
      agent: agent.address, counterparty: merchant, burner, token: USDC,
      maxPerTx: 50_000n, maxPerPeriod: 80_000n, trancheCap: TRANCHE, period: 86_400,
      validAfter: 0n, expiry: BigInt((await chainNow()) + 30 * 86_400), nonce: 1n,
    };
    const signature = await signIntent(owner, vault, 8453, intent);
    await ok(await wallet(attacker).writeContract({ address: vault, abi: V, functionName: "proposeIntent", args: [intent, signature] }));
    intentId = (await pub.readContract({ address: vault, abi: V, functionName: "intentId", args: [intent] })) as Hex;

    // Before the timelock the vault refuses to fund the payer, so nothing is signed.
    const before = signaturesSeen.length;
    await expect(payOnce()).rejects.toThrow();
    expect(signaturesSeen.length).toBe(before);
    expect(await bal(merchant)).toBe(0n);
    await test.increaseTime({ seconds: 3601 });
    await test.mine({ blocks: 1 });
  });

  it("3. paying: the SDK tops up the signed payer once, then pays from it; fees split 50/50", async () => {
    const r1 = await payOnce();
    expect(r1.status).toBe(200);
    expect(r1.payment?.settlement.success).toBe(true);
    expect(await bal(merchant)).toBe(PRICE);
    expect(await bal(burner)).toBe(TRANCHE - PRICE);
    expect(await bal(jar)).toBe(20n); // 0.1% of the 40,000 tranche = 40, half to the jar
    expect(await bal(ops.address)).toBe(20n);
    const r2 = await payOnce();
    expect(r2.status).toBe(200);
    expect(await bal(burner)).toBe(TRANCHE - 2n * PRICE); // no second top-up
  });

  it("4. the owner sweeps a payer's leftovers back with an EIP-3009 receive authorization", async () => {
    const left = await bal(burner);
    const b = privateKeyToAccount(deriveBurnerKey({ ownerSeed: seed, vault, chainId: 8453, counterparty: merchant }));
    const validBefore = BigInt((await chainNow()) + 3600);
    const nonce = keccak256(toHex("sweep-1"));
    const signature = await b.signTypedData({
      domain: { name: "USD Coin", version: "2", chainId: 8453, verifyingContract: USDC },
      types: { ReceiveWithAuthorization: [
        { name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" },
      ] },
      primaryType: "ReceiveWithAuthorization",
      message: { from: burner, to: vault, value: left, validAfter: 0n, validBefore, nonce },
    });
    const vaultBefore = await bal(vault);
    await ok(await wallet(attacker).writeContract({ address: vault, abi: V, functionName: "sweepBurner", args: [burner, left, 0n, validBefore, nonce, signature] }));
    expect(await bal(burner)).toBe(0n);
    expect(await bal(vault)).toBe(vaultBefore + left);
  });

  it("5. the daily cap holds on-chain: once the window is used up, no top-up and no signature", async () => {
    // Window so far: one 40,000 tranche. A second tranche reaches the 80,000 cap exactly.
    for (let i = 0; i < 4; i++) expect((await payOnce()).status).toBe(200);
    expect(await bal(burner)).toBe(0n);
    const before = signaturesSeen.length;
    await expect(payOnce()).rejects.toThrow(); // a third tranche would exceed maxPerPeriod
    expect(signaturesSeen.length).toBe(before);
    expect(await bal(merchant)).toBe(6n * PRICE);
  });

  it("6. attacks: an over-priced 402 and a 402 to another payee are refused before signing", async () => {
    const before = signaturesSeen.length;
    await expect(payOnce("/pricey")).rejects.toThrow();
    await expect(payOnce("/evil")).rejects.toThrow();
    expect(signaturesSeen.length).toBe(before);
    expect(await bal(attacker.address)).toBe(0n);
  });

  it("7. renewal: a new budget for the same merchant and payer; a stolen agent key still cannot redirect tranches", async () => {
    const intent = {
      agent: agent.address, counterparty: merchant, burner, token: USDC,
      maxPerTx: 50_000n, maxPerPeriod: 80_000n, trancheCap: TRANCHE, period: 86_400,
      validAfter: 0n, expiry: BigInt((await chainNow()) + 30 * 86_400), nonce: 2n,
    };
    const signature = await signIntent(owner, vault, 8453, intent);
    await ok(await wallet(agent).writeContract({ address: vault, abi: V, functionName: "proposeIntent", args: [intent, signature] }));
    intentId = (await pub.readContract({ address: vault, abi: V, functionName: "intentId", args: [intent] })) as Hex;
    await test.increaseTime({ seconds: 3601 });
    await test.mine({ blocks: 1 });
    await expect(
      wallet(agent).writeContract({ address: vault, abi: V, functionName: "fundBurner", args: [intentId, attacker.address, 10_000n] }),
    ).rejects.toThrow(/NotSignedBurner/);
    expect(await bal(attacker.address)).toBe(0n);
  });

  it("8. pause and revoke are instant for new top-ups; funds already in the payer remain spendable", async () => {
    expect((await payOnce()).status).toBe(200); // renewed budget tops up the same payer (S-M-2 fixed)
    await ok(await wallet(owner).writeContract({ address: vault, abi: V, functionName: "setPaused", args: [true] }));
    expect((await payOnce()).status).toBe(200); // paid from the payer's existing balance, as documented
    await ok(await wallet(owner).writeContract({ address: vault, abi: V, functionName: "setPaused", args: [false] }));
    await ok(await wallet(owner).writeContract({ address: vault, abi: V, functionName: "revokeIntent", args: [intentId] }));
    expect((await payOnce()).status).toBe(200);
    expect((await payOnce()).status).toBe(200);
    expect(await bal(burner)).toBe(0n);
    const before = signaturesSeen.length;
    await expect(payOnce()).rejects.toThrow(); // revoked: no top-up
    expect(signaturesSeen.length).toBe(before);
  });

  it("9. the owner withdraws everything; fees are in the jar and only a releaser could move them", async () => {
    const all = await bal(vault);
    await ok(await wallet(owner).writeContract({ address: vault, abi: V, functionName: "withdraw", args: [owner.address, all] }));
    expect(await bal(vault)).toBe(0n);
    expect(await pub.readContract({ address: vault, abi: V, functionName: "owedJar" })).toBe(0n);
    expect(await pub.readContract({ address: vault, abi: V, functionName: "owedOps" })).toBe(0n);
    // Three tranches of 40,000 were funded: 120 in fees, 60 each.
    expect(await bal(jar)).toBe(60n);
    expect(await bal(ops.address)).toBe(60n);
    const J = art("FeeJar").abi as Abi;
    await expect(wallet(attacker).writeContract({ address: jar, abi: J, functionName: "release", args: [[USDC], attacker.address] })).rejects.toThrow(/NotReleaser/);
    expect(await bal(merchant)).toBe(10n * PRICE);
  });
});
