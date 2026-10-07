import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createTestClient,
  createWalletClient,
  decodeEventLog,
  encodeAbiParameters,
  encodeFunctionData,
  erc20Abi,
  http,
  keccak256,
  pad,
  parseAbi,
  publicActions,
  toHex,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { hashTypedData } from "viem";
import { base } from "viem/chains";
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader, encodePaymentResponseHeader } from "@x402/core/http";
import { ExactEvmScheme } from "@x402/evm/exact/facilitator";
import { toFacilitatorEvmSigner } from "@x402/evm";
import { getProxyFactoryDeployment, getSafeL2SingletonDeployment, getCompatibilityFallbackHandlerDeployment } from "@safe-global/safe-deployments";
import { createAgentPay, MerchantRegistry, PINNED_USDC, burnerAddress, burnerPayers } from "@deepfirstsearch/agent-pay";
import { agentPayRoleCalls, rolesFunder, roleKey, ROLES_ABI, ROLES_STATUS, ZODIAC } from "../src/index.js";

/**
 * A Safe on a fork of Base mainnet gives an agent an x402 budget through Zodiac Roles v2: real USDC (FiatToken v2.2),
 * the canonical Safe 1.4.1 and Roles 2.1.1 deployments, the SDK, and the official x402 facilitator settling on-chain.
 * Requires anvil and BASE_FORK_RPC (e.g. https://base-rpc.publicnode.com); skipped otherwise. Nothing touches mainnet.
 */
const ANVIL = [join(homedir(), ".foundry/bin/anvil"), "/usr/local/bin/anvil"].find(existsSync);
const FORK = process.env.BASE_FORK_RPC;
const canRun = ANVIL !== undefined && !!FORK;

const PORT = 8563;
const NETWORK = "eip155:8453";
const USDC = PINNED_USDC[NETWORK]!.asset as Address;
const USDC_BALANCE_SLOT = 9n; // FiatToken v2.2 balanceAndBlacklistStates
const PRICE = 10_000n; // 0.01 USDC
const TRANCHE = 40_000n;
const DAILY_CAP = 100_000n; // 0.10 USDC per day may leave the Safe

const SAFE_SINGLETON = getSafeL2SingletonDeployment({ version: "1.4.1", network: "8453" })!;
const SAFE_FACTORY = getProxyFactoryDeployment({ version: "1.4.1", network: "8453" })!;
const FALLBACK = getCompatibilityFallbackHandlerDeployment({ version: "1.4.1", network: "8453" })!;
const SAFE_ABI = SAFE_SINGLETON.abi;
const MODULE_FACTORY_ABI = parseAbi([
  "function deployModule(address masterCopy, bytes initializer, uint256 saltNonce) returns (address proxy)",
  "event ModuleProxyCreation(address indexed proxy, address indexed masterCopy)",
]);

describe.skipIf(!canRun)("Zodiac Roles v2 x402 budget on a Base mainnet fork", { timeout: 180_000 }, () => {
  let anvil: ChildProcess;
  let server: Server;
  let url = "";
  const transport = http(`http://127.0.0.1:${PORT}`);
  const pub = createPublicClient({ chain: base, transport, pollingInterval: 50 });
  const test = createTestClient({ chain: base, transport, mode: "anvil" });
  const key = () => privateKeyToAccount(generatePrivateKey());
  const [owner, agent, facilitatorAcct, attacker] = [key(), key(), key(), key()];
  const merchant = key().address;
  const seed = new Uint8Array(32).fill(9);
  const wallet = (acct: ReturnType<typeof key>) => createWalletClient({ chain: base, transport, account: acct });
  const bal = (a: Address) => pub.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [a] });
  const gas: Record<string, bigint> = {};
  let safe: Address, roles: Address, payer: Address;

  /** The owner (1-of-1) executes a Safe transaction, approving it as msg.sender (signature type v=1). */
  const safeExec = async (to: Address, data: Hex) => {
    const sig = `${pad(owner.address, { size: 32 })}${"0".repeat(64)}01` as Hex;
    const hash = await wallet(owner).writeContract({
      address: safe, abi: SAFE_ABI, functionName: "execTransaction",
      args: [to, 0n, data, 0, 0n, 0n, 0n, zeroAddress, zeroAddress, sig],
    });
    const r = await pub.waitForTransactionReceipt({ hash });
    expect(r.status).toBe("success");
    return r;
  };

  /** Calls Roles as the agent, bypassing the SDK (a compromised agent key), and returns the revert reason. */
  const agentTries = async (to: Address, data: Hex, operation = 0): Promise<string> => {
    try {
      await pub.simulateContract({
        address: roles, abi: ROLES_ABI, functionName: "execTransactionWithRole",
        args: [to, 0n, data, operation, roleKey("agent-pay"), true], account: agent.address,
      });
      return "ALLOWED";
    } catch (e) {
      const err = e instanceof BaseError ? e.walk((x) => x instanceof ContractFunctionRevertedError) : null;
      if (err instanceof ContractFunctionRevertedError && err.data?.errorName === "ConditionViolation") {
        return `ConditionViolation(${ROLES_STATUS[Number(err.data.args![0])]})`;
      }
      return err instanceof ContractFunctionRevertedError ? (err.data?.errorName ?? err.reason ?? "reverted") : String(e).slice(0, 80);
    }
  };

  beforeAll(async () => {
    anvil = spawn(ANVIL!, ["--fork-url", FORK!, "--port", String(PORT), "--silent"], { stdio: "ignore" });
    for (let i = 0; i < 200; i++) {
      try { await pub.getChainId(); break; } catch { await new Promise((r) => setTimeout(r, 150)); }
    }
    for (const a of [owner, agent, facilitatorAcct]) await test.setBalance({ address: a.address, value: 10n ** 18n });

    // A minimal x402 resource server built with the official codecs and facilitator.
    const facilitatorClient = wallet(facilitatorAcct).extend(publicActions);
    const facilitator = new ExactEvmScheme(toFacilitatorEvmSigner({ ...facilitatorClient, address: facilitatorAcct.address } as never));
    const requirement = {
      scheme: "exact", network: NETWORK, amount: String(PRICE), asset: USDC, payTo: merchant,
      // Two days: the test moves the chain clock a day ahead of the wall clock the SDK signs with.
      maxTimeoutSeconds: 172_800, extra: { name: "USD Coin", version: "2", assetTransferMethod: "eip3009" },
    };
    server = createServer(async (req, res) => {
      const sig = req.headers["payment-signature"];
      if (typeof sig !== "string") {
        res.writeHead(402, { "PAYMENT-REQUIRED": encodePaymentRequiredHeader({ x402Version: 2, resource: { url: `${url}${req.url}` }, accepts: [requirement] } as never) }).end();
        return;
      }
      try {
        const payload = decodePaymentSignatureHeader(sig);
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
  }, 180_000);

  afterAll(async () => {
    await new Promise((r) => server?.close(r));
    anvil?.kill();
  });

  it("1. the canonical Safe 1.4.1 and Roles 2.1.1 contracts exist on Base", async () => {
    for (const a of [SAFE_SINGLETON.networkAddresses["8453"], SAFE_FACTORY.networkAddresses["8453"], ZODIAC.rolesV2Mastercopy, ZODIAC.moduleProxyFactory]) {
      expect(((await pub.getCode({ address: a as Address })) ?? "0x").length).toBeGreaterThan(2);
    }
  });

  it("2. the owner deploys a 1-of-1 Safe and funds it with 1 USDC", async () => {
    const setup = encodeFunctionData({
      abi: SAFE_ABI, functionName: "setup",
      args: [[owner.address], 1n, zeroAddress, "0x", FALLBACK.networkAddresses["8453"], zeroAddress, 0n, zeroAddress],
    });
    const hash = await wallet(owner).writeContract({
      address: SAFE_FACTORY.networkAddresses["8453"] as Address, abi: SAFE_FACTORY.abi, functionName: "createProxyWithNonce",
      args: [SAFE_SINGLETON.networkAddresses["8453"], setup, 1n],
    });
    const r = await pub.waitForTransactionReceipt({ hash });
    const created = r.logs.map((l) => { try { return decodeEventLog({ abi: SAFE_FACTORY.abi, ...l }) as { eventName: string; args: { proxy: Address } }; } catch { return null; } }).find((e) => e?.eventName === "ProxyCreation");
    safe = created!.args.proxy;
    const slot = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [safe, USDC_BALANCE_SLOT]));
    await test.setStorageAt({ address: USDC, index: slot, value: toHex(1_000_000n, { size: 32 }) });
    expect(await bal(safe)).toBe(1_000_000n);
    expect(await pub.readContract({ address: safe, abi: SAFE_ABI, functionName: "getOwners" })).toEqual([owner.address]);
  });

  it("3. the Safe deploys and enables its Roles modifier, and gives the agent the agent-pay role", async () => {
    const init = encodeFunctionData({ abi: ROLES_ABI, functionName: "setUp", args: [encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "address" }], [safe, safe, safe])] });
    const hash = await wallet(owner).writeContract({ address: ZODIAC.moduleProxyFactory, abi: MODULE_FACTORY_ABI, functionName: "deployModule", args: [ZODIAC.rolesV2Mastercopy, init, 7n] });
    const r = await pub.waitForTransactionReceipt({ hash });
    const ev = r.logs.map((l) => { try { return decodeEventLog({ abi: MODULE_FACTORY_ABI, ...l }) as { eventName: string; args: { proxy: Address } }; } catch { return null; } }).find((e) => e?.eventName === "ModuleProxyCreation");
    roles = ev!.args.proxy;
    await safeExec(safe, encodeFunctionData({ abi: SAFE_ABI, functionName: "enableModule", args: [roles] }));

    // The agent's payers are derived from the owner's seed, one per merchant, before any payment.
    payer = burnerAddress({ ownerSeed: seed, vault: safe, chainId: 8453, counterparty: merchant });
    for (const c of agentPayRoleCalls({ roles, usdc: USDC, agent: agent.address, payers: [payer], dailyCap: DAILY_CAP })) {
      const rc = await safeExec(c.to, c.data);
      gas[`config ${c.data.slice(0, 10)}`] = rc.gasUsed;
    }
    if (!(await pub.readContract({ address: roles, abi: ROLES_ABI, functionName: "isModuleEnabled", args: [agent.address] }))) {
      await safeExec(roles, encodeFunctionData({ abi: ROLES_ABI, functionName: "enableModule", args: [agent.address] }));
    }
    expect(await pub.readContract({ address: roles, abi: ROLES_ABI, functionName: "isModuleEnabled", args: [agent.address] })).toBe(true);
  });

  const makePay = () =>
    createAgentPay({
      registry: new MerchantRegistry([{ origin: url, payTo: merchant, network: NETWORK, maxPerTx: 50_000n, pricePin: PRICE }]),
      policy: { allowedNetworks: [NETWORK], timeoutBounds: { min: 10, max: 172_800 } },
      payer: burnerPayers(seed, safe),
      session: { readsUntrustedInput: true, accessesSensitiveData: false, canPay: true },
      ensureFunded: rolesFunder({ agent: wallet(agent), publicClient: pub as never, roles, usdc: USDC, tranche: TRANCHE, payers: [payer], confirmations: 1 }),
    });
  const payOnce = async () => {
    const pay = makePay();
    const plan = pay.commitPlan([{ origin: url, maxSpend: 100_000n }], 600_000);
    return pay.fetch(`${url}/data`, {}, { plan });
  };

  it("4. the agent pays the merchant over x402: the SDK tops up the payer from the Safe through Roles, once", async () => {
    const before = await pub.getBlockNumber();
    const r1 = await payOnce();
    expect(r1.status).toBe(200);
    expect(r1.payment?.settlement.success).toBe(true);
    expect(await bal(merchant)).toBe(PRICE);
    expect(await bal(payer)).toBe(TRANCHE - PRICE);
    expect(await bal(safe)).toBe(1_000_000n - TRANCHE);
    const r2 = await payOnce();
    expect(r2.status).toBe(200);
    expect(await bal(payer)).toBe(TRANCHE - 2n * PRICE); // no second top-up
    // Gas of the Roles top-up transaction.
    for (let n = before + 1n; n <= (await pub.getBlockNumber()); n++) {
      for (const tx of (await pub.getBlock({ blockNumber: n, includeTransactions: true })).transactions) {
        if (tx.from.toLowerCase() === agent.address.toLowerCase()) gas["agent top-up via Roles"] = (await pub.getTransactionReceipt({ hash: tx.hash })).gasUsed;
      }
    }
    expect(gas["agent top-up via Roles"]).toBeGreaterThan(0n);
  });

  it("5. a compromised agent key can't redirect, overspend or do anything else (checked by Roles on-chain)", async () => {
    const transfer = (to: Address, v: bigint) => encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to, v] });
    const reasons = {
      payToAttacker: await agentTries(USDC, transfer(attacker.address, 1_000n)),
      overDailyCap: await agentTries(USDC, transfer(payer, DAILY_CAP)), // 40,000 already used today
      approveAttacker: await agentTries(USDC, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [attacker.address, 10n ** 12n] })),
      callTheSafe: await agentTries(safe, encodeFunctionData({ abi: SAFE_ABI, functionName: "addOwnerWithThreshold", args: [attacker.address, 1n] })),
      delegateCall: await agentTries(USDC, transfer(payer, 1_000n), 1),
      withinLimits: await agentTries(USDC, transfer(payer, 1_000n)),
    };
    console.log("revert reasons:", reasons);
    expect(reasons.payToAttacker).toBe("ConditionViolation(ParameterNotAllowed)");
    expect(reasons.overDailyCap).toBe("ConditionViolation(AllowanceExceeded)");
    expect(reasons.approveAttacker).toBe("ConditionViolation(FunctionNotAllowed)");
    expect(reasons.callTheSafe).toBe("ConditionViolation(TargetAddressNotAllowed)");
    expect(reasons.delegateCall).toBe("ConditionViolation(DelegateCallNotAllowed)");
    expect(reasons.withinLimits).toBe("ALLOWED");
    // Someone without the role can't use it at all.
    const outsider = await pub.simulateContract({
      address: roles, abi: ROLES_ABI, functionName: "execTransactionWithRole",
      args: [USDC, 0n, transfer(payer, 1_000n), 0, roleKey("agent-pay"), true], account: attacker.address,
    }).then(() => "ALLOWED", (e) => (e instanceof BaseError ? (e.walk((x) => x instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null)?.data?.errorName : String(e)));
    expect(outsider).not.toBe("ALLOWED");
    console.log("outsider:", outsider);
  });

  it("6. the daily allowance stops the SDK too, and refills the next day", async () => {
    // Spend the payer down and use the rest of today's allowance: 40,000 used; two more tranches would need 80,000.
    const r3 = await payOnce(); expect(r3.status).toBe(200); // payer still had funds
    const r4 = await payOnce(); expect(r4.status).toBe(200);
    expect(await bal(payer)).toBe(0n);
    const r5 = await payOnce(); expect(r5.status).toBe(200); // second top-up: 80,000 of 100,000 used
    for (let i = 0; i < 3; i++) expect((await payOnce()).status).toBe(200);
    expect(await bal(payer)).toBe(0n);
    await expect(payOnce()).rejects.toThrow(); // a third top-up would exceed the 100,000 daily cap
    expect(await bal(merchant)).toBe(8n * PRICE);
    await test.increaseTime({ seconds: 86_401 });
    await test.mine({ blocks: 1 });
    expect((await payOnce()).status).toBe(200);
    expect(await bal(merchant)).toBe(9n * PRICE);
    console.log("gas used:", Object.fromEntries(Object.entries(gas).map(([k, v]) => [k, Number(v)])));
  });

  it("7. with several merchants, the role accepts exactly their payers (an Or of addresses)", async () => {
    const other = key().address;
    const payer2 = burnerAddress({ ownerSeed: seed, vault: safe, chainId: 8453, counterparty: other });
    for (const c of agentPayRoleCalls({ roles, usdc: USDC, agent: agent.address, payers: [payer, payer2], dailyCap: DAILY_CAP, role: "agent-pay-2" })) await safeExec(c.to, c.data);
    const tryRole = (to: Address) => pub.simulateContract({
      address: roles, abi: ROLES_ABI, functionName: "execTransactionWithRole",
      args: [USDC, 0n, encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to, 1_000n] }), 0, roleKey("agent-pay-2"), true], account: agent.address,
    }).then(() => "ALLOWED", (e) => { const x = (e as BaseError).walk((y) => y instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError; return x?.data?.errorName === "ConditionViolation" ? ROLES_STATUS[Number(x.data.args![0])] : "reverted"; });
    expect(await tryRole(payer)).toBe("ALLOWED");
    expect(await tryRole(payer2)).toBe("ALLOWED");
    expect(await tryRole(attacker.address)).toBe("OrViolation");
  });

  it("8. open question (path b): USDC accepts an EIP-3009 authorization signed by the Safe itself (ERC-1271)", async () => {
    const value = 5_000n, nonce = keccak256(toHex("safe-pays-1"));
    const now = Number((await pub.getBlock()).timestamp);
    const message = { from: safe, to: merchant, value, validAfter: 0n, validBefore: BigInt(now + 3600), nonce };
    const digest = hashTypedData({
      domain: { name: "USD Coin", version: "2", chainId: 8453, verifyingContract: USDC },
      types: { TransferWithAuthorization: [
        { name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" },
      ] },
      primaryType: "TransferWithAuthorization", message,
    });
    // Safe 1.4.1 + CompatibilityFallbackHandler: isValidSignature(bytes32) checks the owners' signatures over SafeMessage(digest).
    const safeMessageHash = hashTypedData({
      domain: { chainId: 8453, verifyingContract: safe }, types: { SafeMessage: [{ name: "message", type: "bytes" }] },
      primaryType: "SafeMessage", message: { message: digest },
    });
    const signature = await owner.sign({ hash: safeMessageHash }); // 65 bytes, v = 27/28: an owner ECDSA signature for the Safe
    const tw = parseAbi(["function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, bytes signature)"]);
    const before = await bal(merchant);
    const hash = await wallet(facilitatorAcct).writeContract({ address: USDC, abi: tw, functionName: "transferWithAuthorization", args: [safe, merchant, value, 0n, message.validBefore, nonce, signature] });
    const r = await pub.waitForTransactionReceipt({ hash });
    console.log("Safe-signed (ERC-1271) transferWithAuthorization:", r.status, "gas", Number(r.gasUsed));
    expect(r.status).toBe("success");
    expect(await bal(merchant)).toBe(before + value);
  });
});
