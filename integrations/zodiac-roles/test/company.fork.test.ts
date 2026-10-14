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
  concat,
  createPublicClient,
  createTestClient,
  createWalletClient,
  decodeEventLog,
  encodeAbiParameters,
  encodeFunctionData,
  erc20Abi,
  http,
  keccak256,
  publicActions,
  toHex,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { base } from "viem/chains";
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader, encodePaymentResponseHeader } from "@x402/core/http";
import { ExactEvmScheme } from "@x402/evm/exact/facilitator";
import { toFacilitatorEvmSigner } from "@x402/evm";
import {
  getCompatibilityFallbackHandlerDeployment,
  getMultiSendCallOnlyDeployment,
  getProxyFactoryDeployment,
  getSafeL2SingletonDeployment,
} from "@safe-global/safe-deployments";
import { createAgentPay, MerchantRegistry, PaymentDeniedError, PINNED_USDC, burnerAddress, burnerPayers } from "@deepfirstsearch/agent-pay";
import {
  agentAllowanceKey,
  agentPayRoleCalls,
  batchCalls,
  budgetKey,
  freezeCalls,
  readAllowance,
  revokeAgentCalls,
  rolesFunder,
  roleKey,
  spendReport,
  teamBudgetCalls,
  ROLES_ABI,
  ROLES_STATUS,
  ZODIAC,
  type SafeCall,
} from "../src/index.js";

/**
 * The company use cases (USE-CASES.md), end to end on a fork of Base mainnet: a 2-of-3 company Safe with real USDC,
 * the canonical Safe 1.4.1, MultiSendCallOnly and Roles 2.1.1 deployments, three agents in two teams, three vendors
 * paid over x402 through the official facilitator, and the SDK in front of every payment.
 * Requires anvil and BASE_FORK_RPC (e.g. https://base-rpc.publicnode.com); skipped otherwise. Nothing touches mainnet.
 */
const ANVIL = [join(homedir(), ".foundry/bin"), "/usr/local/bin", ...(process.env.PATH ?? "").split(":")].map((d) => join(d, "anvil")).find(existsSync);
const FORK = process.env.BASE_FORK_RPC;
const canRun = ANVIL !== undefined && !!FORK;

const PORT = 8564;
const NETWORK = "eip155:8453";
const USDC = PINNED_USDC[NETWORK]!.asset as Address;
const USDC_BALANCE_SLOT = 9n; // FiatToken v2.2 balanceAndBlacklistStates
const TREASURY = 1_000_000_000n; // 1,000 USDC in the company Safe
const PRICE = 10_000n; // 0.01 USDC per call
const TRANCHE = 30_000n; // what one top-up moves from the Safe to a payer
const RESEARCH_BUDGET = 100_000n; // per day, shared by the research team
const RESEARCH_AGENT_CAP = 60_000n; // per day, per research agent
const SUPPORT_CAP = 50_000n; // per 30 days, the support agent
const MONTH = 30 * 86_400;
// The test moves the chain clock up to a month ahead of the wall clock, which the SDK and the facilitator use, so the
// authorizations are valid for longer than that here. Real deployments keep the usual few minutes.
const TEST_WINDOW = 40 * 86_400;

const SAFE_SINGLETON = getSafeL2SingletonDeployment({ version: "1.4.1", network: "8453" })!;
const SAFE_FACTORY = getProxyFactoryDeployment({ version: "1.4.1", network: "8453" })!;
const FALLBACK = getCompatibilityFallbackHandlerDeployment({ version: "1.4.1", network: "8453" })!;
const MULTISEND = getMultiSendCallOnlyDeployment({ version: "1.4.1", network: "8453" })!.networkAddresses["8453"] as Address;
const SAFE_ABI = SAFE_SINGLETON.abi;
const MODULE_FACTORY_ABI = [
  { type: "function", name: "deployModule", stateMutability: "nonpayable", inputs: [{ name: "masterCopy", type: "address" }, { name: "initializer", type: "bytes" }, { name: "saltNonce", type: "uint256" }], outputs: [{ name: "proxy", type: "address" }] },
  { type: "event", name: "ModuleProxyCreation", inputs: [{ name: "proxy", type: "address", indexed: true }, { name: "masterCopy", type: "address", indexed: true }] },
] as const;

const key = () => privateKeyToAccount(generatePrivateKey());
const revertName = (e: unknown): string => {
  const err = e instanceof BaseError ? e.walk((x) => x instanceof ContractFunctionRevertedError) : null;
  if (err instanceof ContractFunctionRevertedError) {
    if (err.data?.errorName === "ConditionViolation") return ROLES_STATUS[Number(err.data.args![0])]!;
    return err.reason ?? err.data?.errorName ?? "reverted"; // Safe reverts with strings (GS0xx)
  }
  return String((e as Error)?.message ?? e).slice(0, 120);
};

describe.skipIf(!canRun)("Company use cases on a Base mainnet fork", { timeout: 300_000 }, () => {
  let anvil: ChildProcess;
  const servers: Server[] = [];
  const transport = http(`http://127.0.0.1:${PORT}`);
  const pub = createPublicClient({ chain: base, transport, pollingInterval: 50 });
  const test = createTestClient({ chain: base, transport, mode: "anvil" });
  const wallet = (a: PrivateKeyAccount) => createWalletClient({ chain: base, transport, account: a });
  const bal = (a: Address) => pub.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [a] });
  const chainNow = async () => Number((await pub.getBlock()).timestamp);

  // The company: three Safe owners (any two sign), an executor that only relays, and the facilitator.
  const [cfo, cto, opsLead, relayer, facilitatorAcct, attacker] = [key(), key(), key(), key(), key(), key()];
  // Three agents in two teams, each with its own key and its own payer seed.
  const agents = {
    research1: { acct: key(), seed: new Uint8Array(32).fill(1), role: "research-1" },
    research2: { acct: key(), seed: new Uint8Array(32).fill(2), role: "research-2" },
    support1: { acct: key(), seed: new Uint8Array(32).fill(3), role: "support-1" },
  };
  type AgentName = keyof typeof agents;
  // Three vendors (x402 sellers), and a hijacked endpoint that names an attacker as payee.
  const vendors = { dataApi: key().address, searchApi: key().address, helpdeskApi: key().address };
  type VendorName = keyof typeof vendors;
  const url: Record<VendorName | "hijacked", string> = { dataApi: "", searchApi: "", helpdeskApi: "", hijacked: "" };
  let safe: Address, roles: Address, startBlock: bigint;
  const payer = (a: AgentName, v: VendorName) =>
    burnerAddress({ ownerSeed: agents[a].seed, vault: safe, chainId: 8453, counterparty: vendors[v] });

  /** Two of the three owners sign (ECDSA over the Safe transaction hash, sorted by owner); the relayer submits. */
  const safeExec = async (call: SafeCall & { operation?: 0 | 1 }, signers: PrivateKeyAccount[] = [cfo, cto]) => {
    const operation = call.operation ?? 0;
    const nonce = await pub.readContract({ address: safe, abi: SAFE_ABI, functionName: "nonce" });
    const hash = (await pub.readContract({
      address: safe, abi: SAFE_ABI, functionName: "getTransactionHash",
      args: [call.to, 0n, call.data, operation, 0n, 0n, 0n, zeroAddress, zeroAddress, nonce],
    })) as Hex;
    const sorted = [...signers].sort((a, b) => (BigInt(a.address) < BigInt(b.address) ? -1 : 1));
    const signatures = concat(await Promise.all(sorted.map((s) => s.sign({ hash }))));
    const args = [call.to, 0n, call.data, operation, 0n, 0n, 0n, zeroAddress, zeroAddress, signatures] as const;
    await pub.simulateContract({ address: safe, abi: SAFE_ABI, functionName: "execTransaction", args, account: relayer.address });
    const tx = await wallet(relayer).writeContract({ address: safe, abi: SAFE_ABI, functionName: "execTransaction", args });
    const r = await pub.waitForTransactionReceipt({ hash: tx });
    expect(r.status).toBe("success");
    return r;
  };

  /** The agent's key used directly against Roles, without the SDK (a stolen key). Returns what Roles says. */
  const rawTopUp = (a: AgentName, data: Hex, to: Address = USDC) =>
    pub.simulateContract({
      address: roles, abi: ROLES_ABI, functionName: "execTransactionWithRole",
      args: [to, 0n, data, 0, roleKey(agents[a].role), true], account: agents[a].acct.address,
    }).then(() => "ALLOWED", revertName);
  const transferData = (to: Address, v: bigint) => encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to, v] });

  /** One paid call, the way the agent makes it: SDK policy first, then a Roles top-up only if the payer needs one. */
  const pay = async (a: AgentName, v: VendorName | "hijacked") => {
    const vendor: VendorName = v === "hijacked" ? "dataApi" : v;
    const sdk = createAgentPay({
      // The owner's registry: each vendor's origin, its payee and price, pinned.
      registry: new MerchantRegistry([{ origin: url[v], payTo: vendors[vendor], network: NETWORK, maxPerTx: 50_000n, pricePin: PRICE }]),
      policy: { allowedNetworks: [NETWORK], timeoutBounds: { min: 10, max: TEST_WINDOW } },
      payer: burnerPayers(agents[a].seed, safe),
      session: { readsUntrustedInput: true, accessesSensitiveData: false, canPay: true },
      ensureFunded: rolesFunder({
        agent: wallet(agents[a].acct), publicClient: pub as never, roles, usdc: USDC, role: agents[a].role,
        tranche: TRANCHE, confirmations: 1,
      }),
    });
    const plan = sdk.commitPlan([{ origin: url[v], maxSpend: 100_000n }], 600_000);
    return sdk.fetch(`${url[v]}/report`, {}, { plan });
  };
  const refusal = (p: Promise<unknown>) =>
    p.then(() => "PAID", (e) => (e instanceof PaymentDeniedError ? `${e.code}: ${e.reasons.join("; ")}` : `ERROR ${String(e).slice(0, 120)}`));

  /** A vendor endpoint built with the official x402 codecs and facilitator. */
  const startVendor = async (payTo: Address) => {
    const facilitatorClient = wallet(facilitatorAcct).extend(publicActions);
    const facilitator = new ExactEvmScheme(toFacilitatorEvmSigner({ ...facilitatorClient, address: facilitatorAcct.address } as never));
    const requirement = {
      scheme: "exact", network: NETWORK, amount: String(PRICE), asset: USDC, payTo,
      maxTimeoutSeconds: TEST_WINDOW, extra: { name: "USD Coin", version: "2", assetTransferMethod: "eip3009" },
    };
    let origin = "";
    const server = createServer(async (req, res) => {
      const sig = req.headers["payment-signature"];
      if (typeof sig !== "string") {
        res.writeHead(402, { "PAYMENT-REQUIRED": encodePaymentRequiredHeader({ x402Version: 2, resource: { url: `${origin}${req.url}` }, accepts: [requirement] } as never) }).end();
        return;
      }
      try {
        const payload = decodePaymentSignatureHeader(sig);
        const v = await facilitator.verify(payload as never, requirement as never);
        if (!v.isValid) return void res.writeHead(402, { "x-verify-error": String(v.invalidReason) }).end();
        const s = await facilitator.settle(payload as never, requirement as never);
        res.writeHead(s.success ? 200 : 402, { "PAYMENT-RESPONSE": encodePaymentResponseHeader(s) }).end("report");
      } catch (e) {
        res.writeHead(500, { "x-error": String(e).slice(0, 200) }).end();
      }
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    servers.push(server);
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return origin;
  };

  beforeAll(async () => {
    anvil = spawn(ANVIL!, ["--fork-url", FORK!, "--port", String(PORT), "--silent"], { stdio: "ignore" });
    for (let i = 0; i < 200; i++) {
      try { await pub.getChainId(); break; } catch { await new Promise((r) => setTimeout(r, 150)); }
    }
    for (const a of [relayer, facilitatorAcct, ...Object.values(agents).map((x) => x.acct)]) {
      await test.setBalance({ address: a.address, value: 10n ** 18n }); // gas only: none of these hold USDC
    }
    for (const v of Object.keys(vendors) as VendorName[]) url[v] = await startVendor(vendors[v]);
    url.hijacked = await startVendor(attacker.address);
    startBlock = (await pub.getBlockNumber()) + 1n; // the first local block: logs before it would come from the remote RPC
  }, 180_000);

  afterAll(async () => {
    await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
    anvil?.kill();
  });

  it("UC1. Finance sets the policy: a 2-of-3 company Safe configures every team and agent in one signed batch", async () => {
    const setup = encodeFunctionData({
      abi: SAFE_ABI, functionName: "setup",
      args: [[cfo.address, cto.address, opsLead.address], 2n, zeroAddress, "0x", FALLBACK.networkAddresses["8453"], zeroAddress, 0n, zeroAddress],
    });
    const created = await pub.waitForTransactionReceipt({
      hash: await wallet(relayer).writeContract({
        address: SAFE_FACTORY.networkAddresses["8453"] as Address, abi: SAFE_FACTORY.abi, functionName: "createProxyWithNonce",
        args: [SAFE_SINGLETON.networkAddresses["8453"], setup, 42n],
      }),
    });
    safe = created.logs.map((l) => { try { return decodeEventLog({ abi: SAFE_FACTORY.abi, ...l }) as { eventName: string; args: { proxy: Address } }; } catch { return null; } })
      .find((e) => e?.eventName === "ProxyCreation")!.args.proxy;
    const slot = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [safe, USDC_BALANCE_SLOT]));
    await test.setStorageAt({ address: USDC, index: slot, value: toHex(TREASURY, { size: 32 }) });
    expect(await bal(safe)).toBe(TREASURY);

    // The Roles modifier, owned by the Safe itself.
    const init = encodeFunctionData({ abi: ROLES_ABI, functionName: "setUp", args: [encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "address" }], [safe, safe, safe])] });
    const deployed = await pub.waitForTransactionReceipt({
      hash: await wallet(relayer).writeContract({ address: ZODIAC.moduleProxyFactory, abi: MODULE_FACTORY_ABI, functionName: "deployModule", args: [ZODIAC.rolesV2Mastercopy, init, 42n] }),
    });
    roles = deployed.logs.map((l) => { try { return decodeEventLog({ abi: MODULE_FACTORY_ABI, ...l }); } catch { return null; } })
      .find((e) => e?.eventName === "ModuleProxyCreation")!.args.proxy as Address;

    // The whole policy: two teams, three agents, the payers of each agent's approved vendors.
    const calls: SafeCall[] = [
      { to: safe, data: encodeFunctionData({ abi: SAFE_ABI, functionName: "enableModule", args: [roles] }) },
      ...teamBudgetCalls({ roles, budget: "research", cap: RESEARCH_BUDGET }),
      ...agentPayRoleCalls({ roles, usdc: USDC, agent: agents.research1.acct.address, role: agents.research1.role, budget: "research", cap: RESEARCH_AGENT_CAP, payers: [payer("research1", "dataApi"), payer("research1", "searchApi")] }),
      ...agentPayRoleCalls({ roles, usdc: USDC, agent: agents.research2.acct.address, role: agents.research2.role, budget: "research", cap: RESEARCH_AGENT_CAP, payers: [payer("research2", "dataApi")] }),
      ...agentPayRoleCalls({ roles, usdc: USDC, agent: agents.support1.acct.address, role: agents.support1.role, cap: SUPPORT_CAP, period: MONTH, payers: [payer("support1", "helpdeskApi")] }),
    ];
    const batch = batchCalls(calls, MULTISEND);

    // One owner alone can't do it (Safe: GS020, not enough signatures), and neither can an agent.
    const alone = await safeExec(batch, [cfo]).then(() => "EXECUTED", revertName);
    expect(alone).toContain("GS020");
    // Two owners sign once; the relayer submits.
    const r = await safeExec(batch);
    console.log(`UC1: ${calls.length} policy calls in one 2-of-3 Safe transaction, gas ${r.gasUsed}`);
    expect(await pub.readContract({ address: safe, abi: SAFE_ABI, functionName: "isModuleEnabled", args: [roles] })).toBe(true);

    // An agent can't rewrite its own policy: the Roles admin functions belong to the Safe.
    const selfGrant = await pub.simulateContract({
      address: roles, abi: ROLES_ABI, functionName: "setAllowance",
      args: [agentAllowanceKey(agents.research1.role), 10n ** 12n, 10n ** 12n, 10n ** 12n, 86_400n, 0n], account: agents.research1.acct.address,
    }).then(() => "ALLOWED", revertName);
    expect(selfGrant).not.toBe("ALLOWED");
    console.log("UC1: agent raising its own cap ->", selfGrant);
  });

  it("UC2. Team budgets: research and support pay their own vendors, and can't fund each other's", async () => {
    expect((await pay("research1", "dataApi")).status).toBe(200);
    expect((await pay("research1", "searchApi")).status).toBe(200);
    expect((await pay("support1", "helpdeskApi")).status).toBe(200);
    expect(await bal(vendors.dataApi)).toBe(PRICE);
    expect(await bal(vendors.searchApi)).toBe(PRICE);
    expect(await bal(vendors.helpdeskApi)).toBe(PRICE);
    // Research spent 2 tranches of its team budget; support's budget is separate.
    expect((await readAllowance({ publicClient: pub as never, roles, key: budgetKey("research") })).available).toBe(RESEARCH_BUDGET - 2n * TRANCHE);
    expect((await readAllowance({ publicClient: pub as never, roles, key: agentAllowanceKey("support-1") })).available).toBe(SUPPORT_CAP - TRANCHE);
    // A research agent's key can't send money to support's payer, nor research2's.
    expect(await rawTopUp("research1", transferData(payer("support1", "helpdeskApi"), 1_000n))).toBe("OrViolation");
    expect(await rawTopUp("research2", transferData(payer("research1", "dataApi"), 1_000n))).toBe("ParameterNotAllowed");
  });

  it("UC3. Per-agent caps inside a team budget: one agent can't use up the team's money", async () => {
    // research1 topped up once per vendor in UC2: 60,000, its whole cap for today. The team has 40,000 left.
    expect((await readAllowance({ publicClient: pub as never, roles, key: agentAllowanceKey("research-1") })).available).toBe(0n);
    expect((await readAllowance({ publicClient: pub as never, roles, key: budgetKey("research") })).available).toBe(RESEARCH_BUDGET - 2n * TRANCHE);
    // It can spend what is already in its dataApi payer, then Roles refuses the next top-up and the SDK says why.
    for (let i = 0; i < 2; i++) expect((await pay("research1", "dataApi")).status).toBe(200);
    const capped = await refusal(pay("research1", "dataApi"));
    expect(capped).toMatch(/^budget_exhausted: .*AllowanceExceeded/);
    console.log("UC3: research1 over its own cap ->", capped);

    // research2 has its whole 60,000, but takes one tranche and leaves the team 10,000 for today.
    for (let i = 0; i < 3; i++) expect((await pay("research2", "dataApi")).status).toBe(200);
    const team = await readAllowance({ publicClient: pub as never, roles, key: budgetKey("research") });
    expect(team.available).toBe(RESEARCH_BUDGET - 3n * TRANCHE);
    expect((await readAllowance({ publicClient: pub as never, roles, key: agentAllowanceKey("research-2") })).available).toBe(RESEARCH_AGENT_CAP - TRANCHE);
    // readAllowance matches Roles to the unit: exactly what's left passes, one more unit doesn't.
    expect(await rawTopUp("research2", transferData(payer("research2", "dataApi"), team.available + 1n))).toBe("AllowanceExceeded");
    expect(await rawTopUp("research2", transferData(payer("research2", "dataApi"), team.available))).toBe("ALLOWED");
    // Its own cap still has 30,000, but the team budget doesn't: refused.
    const teamCapped = await refusal(pay("research2", "dataApi"));
    expect(teamCapped).toMatch(/^budget_exhausted: .*AllowanceExceeded/);
    console.log("UC3: research2 over the team budget ->", teamCapped, `| team refills at ${new Date(team.nextRefillAt! * 1000).toISOString()}`);
    // Support isn't affected.
    expect((await pay("support1", "helpdeskApi")).status).toBe(200);
  });

  it("UC4. Approved vendors only, checked twice: a hijacked 402 is refused before signing, a stolen key on-chain", async () => {
    const safeBefore = await bal(safe);
    // The agent calls a vendor whose endpoint now asks to pay an attacker: the SDK refuses, nothing is signed or moved.
    const hijacked = await refusal(pay("support1", "hijacked"));
    expect(hijacked).toMatch(/^payee_mismatch/);
    expect(await bal(attacker.address)).toBe(0n);
    expect(await bal(safe)).toBe(safeBefore);
    console.log("UC4: hijacked endpoint ->", hijacked);
    // The agent's key itself is stolen and used without the SDK: Roles refuses everything outside the policy.
    const stolen = {
      payTheAttacker: await rawTopUp("support1", transferData(attacker.address, 1_000n)),
      approveTheAttacker: await rawTopUp("support1", encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [attacker.address, 10n ** 12n] })),
      addAnOwner: await rawTopUp("support1", encodeFunctionData({ abi: SAFE_ABI, functionName: "addOwnerWithThreshold", args: [attacker.address, 1n] }), safe),
    };
    expect(stolen).toEqual({ payTheAttacker: "ParameterNotAllowed", approveTheAttacker: "FunctionNotAllowed", addAnOwner: "TargetAddressNotAllowed" });
    console.log("UC4: stolen agent key ->", stolen);
  });

  it("UC5. Incident response: freeze a team or revoke one agent with one Safe transaction", async () => {
    // A new day: research's budgets refill.
    await test.increaseTime({ seconds: 86_400 });
    await test.mine({ blocks: 1 });
    expect((await readAllowance({ publicClient: pub as never, roles, key: budgetKey("research") })).available).toBe(RESEARCH_BUDGET);

    // Something looks wrong in research: two owners freeze the whole team.
    await safeExec(freezeCalls({ roles, budget: "research" })[0]!);
    const exposure = (await bal(payer("research1", "dataApi"))) + (await bal(payer("research1", "searchApi"))) + (await bal(payer("research2", "dataApi")));
    expect(exposure).toBeLessThanOrEqual(3n * TRANCHE); // at most one tranche per payer is outside the Safe
    // Agents can still spend what is already in their payers, and nothing more.
    let paid = 0n;
    for (;;) {
      const r = await refusal(pay("research2", "dataApi"));
      if (r !== "PAID") { expect(r).toMatch(/^budget_exhausted: .*AllowanceExceeded/); break; }
      paid += PRICE;
    }
    expect(paid).toBeLessThanOrEqual(TRANCHE);
    // Support keeps working.
    expect((await pay("support1", "helpdeskApi")).status).toBe(200);

    // research1's key is the suspect: revoke it, then lift the freeze for the rest of the team.
    await safeExec(batchCalls([...revokeAgentCalls({ roles, agent: agents.research1.acct.address, role: "research-1" }), ...teamBudgetCalls({ roles, budget: "research", cap: RESEARCH_BUDGET })], MULTISEND));
    expect(await rawTopUp("research1", transferData(payer("research1", "dataApi"), 1_000n))).toBe("NoMembership");
    expect((await pay("research2", "dataApi")).status).toBe(200);
    console.log(`UC5: frozen team spent ${paid} from its payers (cap ${TRANCHE} each); exposure at freeze ${exposure}`);
  });

  it("UC6. Monthly budgets: support's cap refills every 30 days, and finance can see when", async () => {
    // Use the rest of this period.
    for (;;) {
      const r = await refusal(pay("support1", "helpdeskApi"));
      if (r !== "PAID") { expect(r).toMatch(/^budget_exhausted/); break; }
    }
    const s = await readAllowance({ publicClient: pub as never, roles, key: agentAllowanceKey("support-1") });
    expect(s.available).toBeLessThan(TRANCHE);
    expect(s.period).toBe(MONTH);
    const now = await chainNow();
    expect(s.nextRefillAt! > now && s.nextRefillAt! <= now + MONTH).toBe(true);
    console.log(`UC6: support has ${s.available} left; refills ${new Date(s.nextRefillAt! * 1000).toISOString()}`);
    await test.setNextBlockTimestamp({ timestamp: BigInt(s.nextRefillAt! + 1) });
    await test.mine({ blocks: 1 });
    expect((await readAllowance({ publicClient: pub as never, roles, key: agentAllowanceKey("support-1") })).available).toBe(SUPPORT_CAP);
    expect((await pay("support1", "helpdeskApi")).status).toBe(200);
  });

  it("UC7. Reconciliation from the chain: spend by team and vendor matches the Safe and every vendor's books", async () => {
    const report = await spendReport({
      publicClient: pub as never, usdc: USDC, safe, fromBlock: startBlock,
      payers: {
        "research / research1 / dataApi": payer("research1", "dataApi"),
        "research / research1 / searchApi": payer("research1", "searchApi"),
        "research / research2 / dataApi": payer("research2", "dataApi"),
        "support / support1 / helpdeskApi": payer("support1", "helpdeskApi"),
      },
    });
    for (const l of report.lines) console.log(`UC7: ${l.label.padEnd(34)} topped up ${l.toppedUp}  paid ${l.paid} in ${l.payments} payments`);
    // Every unit that left the Safe went to a listed payer.
    expect(report.toppedUp).toBe(TREASURY - (await bal(safe)));
    // Every unit paid reached a vendor, and each vendor's balance is exactly what the report says it was paid.
    const byVendor = (v: Address) => report.lines.reduce((s, l) => s + (l.byPayee[v] ?? 0n), 0n);
    for (const v of Object.values(vendors)) expect(byVendor(v)).toBe(await bal(v));
    expect(report.paid).toBe((await bal(vendors.dataApi)) + (await bal(vendors.searchApi)) + (await bal(vendors.helpdeskApi)));
    // What is not yet spent sits in the payers, at most one tranche each.
    for (const l of report.lines) expect(l.toppedUp - l.paid).toBe(await bal(l.payer));
    for (const l of report.lines) expect(l.toppedUp - l.paid).toBeLessThanOrEqual(TRANCHE);
    expect(await bal(attacker.address)).toBe(0n);
  });
});
