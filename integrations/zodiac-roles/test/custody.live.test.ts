import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
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
  defineChain,
  encodeAbiParameters,
  encodeFunctionData,
  erc20Abi,
  http,
  keccak256,
  pad,
  toHex,
  zeroAddress,
  type Account,
  type Address,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount, toAccount } from "viem/accounts";
import { base } from "viem/chains";
import { getCompatibilityFallbackHandlerDeployment, getProxyFactoryDeployment, getSafeL2SingletonDeployment } from "@safe-global/safe-deployments";
import { PaymentDeniedError, PINNED_USDC } from "@deepfirstsearch/agent-pay";
import { agentPayRoleCalls, revokeAgentCalls, rolesFunder, roleKey, ROLES_ABI, ROLES_STATUS, ZODIAC } from "../src/index.js";

/**
 * The agent's Roles key held by a custodian (Turnkey, Privy, Coinbase CDP) instead of a raw private key: each one
 * signs the agent's top-up transactions through Roles. Live: it calls the real Turnkey, Privy and CDP APIs, so it
 * needs CUSTODY_CREDS_DIR with turnkey-api.json, privy.json, cdp-api-key.json and cdp-wallet-secret.json (each
 * custodian runs only when its files are there; never in CI), plus anvil and BASE_FORK_RPC. Turnkey also needs
 * TURNKEY_SIGNING=1 (see below).
 *
 * The fork runs under chain id 31337, not Base's 8453, so nothing the custodians sign here is valid on Base mainnet.
 */
const ANVIL = [join(homedir(), ".foundry/bin"), "/usr/local/bin", ...(process.env.PATH ?? "").split(":")].map((d) => join(d, "anvil")).find(existsSync);
const FORK = process.env.BASE_FORK_RPC;
const DIR = process.env.CUSTODY_CREDS_DIR;
const has = (...files: string[]) => !!DIR && files.every((f) => existsSync(join(DIR, f)));
const creds = (f: string) => JSON.parse(readFileSync(join(DIR!, f), "utf8"));
const canRun = ANVIL !== undefined && !!FORK && has() && (has("turnkey-api.json") || has("privy.json") || has("cdp-api-key.json", "cdp-wallet-secret.json"));

const PORT = 8565;
const CHAIN = defineChain({ ...base, id: 31337, name: "Base fork (chain id 31337)" });
const USDC = PINNED_USDC["eip155:8453"]!.asset as Address;
const USDC_BALANCE_SLOT = 9n;
const TRANCHE = 30_000n;
const CAP = 100_000n;
const SAFE_SINGLETON = getSafeL2SingletonDeployment({ version: "1.4.1", network: "8453" })!;
const SAFE_FACTORY = getProxyFactoryDeployment({ version: "1.4.1", network: "8453" })!;
const FALLBACK = getCompatibilityFallbackHandlerDeployment({ version: "1.4.1", network: "8453" })!;
const SAFE_ABI = SAFE_SINGLETON.abi;
const MODULE_FACTORY_ABI = [
  { type: "function", name: "deployModule", stateMutability: "nonpayable", inputs: [{ name: "masterCopy", type: "address" }, { name: "initializer", type: "bytes" }, { name: "saltNonce", type: "uint256" }], outputs: [{ name: "proxy", type: "address" }] },
  { type: "event", name: "ModuleProxyCreation", inputs: [{ name: "proxy", type: "address", indexed: true }, { name: "masterCopy", type: "address", indexed: true }] },
] as const;

/** Each custodian's viem account, built with the custodian's own SDK and adapter. */
const CUSTODIANS: { name: string; available: () => boolean; account: () => Promise<Account> }[] = [
  {
    name: "Turnkey",
    // Opt-in: our free Turnkey organization is over its signing quota ("Resource exhausted"), so this one has not run
    // live yet. Set TURNKEY_SIGNING=1 with an organization that can sign.
    available: () => has("turnkey-api.json") && process.env.TURNKEY_SIGNING === "1",
    account: async () => {
      const { Turnkey } = await import("@turnkey/sdk-server");
      const { createAccount } = await import("@turnkey/viem");
      const c = creds("turnkey-api.json");
      const tk = new Turnkey({ apiBaseUrl: "https://api.turnkey.com", apiPublicKey: c.apiPublicKey, apiPrivateKey: c.apiPrivateKey, defaultOrganizationId: c.organizationId });
      return (await createAccount({ client: tk.apiClient(), organizationId: c.organizationId, signWith: c.address })) as Account;
    },
  },
  {
    name: "Privy",
    available: () => has("privy.json"),
    account: async () => {
      const { PrivyClient } = await import("@privy-io/node");
      const { createViemAccount } = await import("@privy-io/node/viem");
      const c = creds("privy.json");
      const privy = new PrivyClient({ appId: c.appId, appSecret: c.appSecret });
      return createViemAccount(privy, { walletId: c.serverWallet.id, address: c.serverWallet.address }) as Account;
    },
  },
  {
    name: "Coinbase CDP",
    available: () => has("cdp-api-key.json", "cdp-wallet-secret.json"),
    account: async () => {
      process.env.DISABLE_CDP_USAGE_TRACKING = "true";
      process.env.DISABLE_CDP_ERROR_REPORTING = "true";
      const { CdpClient } = await import("@coinbase/cdp-sdk");
      const k = creds("cdp-api-key.json"), w = creds("cdp-wallet-secret.json");
      const cdp = new CdpClient({ apiKeyId: k.id, apiKeySecret: k.privateKey, walletSecret: w.walletSecret });
      return toAccount(await cdp.evm.getOrCreateAccount({ name: "zodiac-roles-agent" })) as Account;
    },
  },
];

describe.skipIf(!canRun)("live: the agent's Roles key held by Turnkey, Privy or Coinbase CDP", { timeout: 240_000 }, () => {
  let anvil: ChildProcess;
  const transport = http(`http://127.0.0.1:${PORT}`);
  const pub = createPublicClient({ chain: CHAIN, transport, pollingInterval: 100 });
  const test = createTestClient({ chain: CHAIN, transport, mode: "anvil" });
  const owner = privateKeyToAccount(generatePrivateKey());
  const attacker = privateKeyToAccount(generatePrivateKey()).address;
  const bal = (a: Address) => pub.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [a] });
  let safe: Address, roles: Address;

  const safeExec = async (to: Address, data: Hex) => {
    const sig = `${pad(owner.address, { size: 32 })}${"0".repeat(64)}01` as Hex;
    const hash = await createWalletClient({ chain: CHAIN, transport, account: owner }).writeContract({
      address: safe, abi: SAFE_ABI, functionName: "execTransaction", args: [to, 0n, data, 0, 0n, 0n, 0n, zeroAddress, zeroAddress, sig],
    });
    expect((await pub.waitForTransactionReceipt({ hash })).status).toBe("success");
  };

  beforeAll(async () => {
    anvil = spawn(ANVIL!, ["--fork-url", FORK!, "--chain-id", "31337", "--port", String(PORT), "--silent"], { stdio: "ignore" });
    for (let i = 0; i < 200; i++) {
      try { if ((await pub.getChainId()) === 31337) break; } catch { /* starting */ }
      await new Promise((r) => setTimeout(r, 150));
    }
    await test.setBalance({ address: owner.address, value: 10n ** 18n });
    const wallet = createWalletClient({ chain: CHAIN, transport, account: owner });
    const setup = encodeFunctionData({ abi: SAFE_ABI, functionName: "setup", args: [[owner.address], 1n, zeroAddress, "0x", FALLBACK.networkAddresses["8453"], zeroAddress, 0n, zeroAddress] });
    const r = await pub.waitForTransactionReceipt({ hash: await wallet.writeContract({ address: SAFE_FACTORY.networkAddresses["8453"] as Address, abi: SAFE_FACTORY.abi, functionName: "createProxyWithNonce", args: [SAFE_SINGLETON.networkAddresses["8453"], setup, 5n] }) });
    safe = r.logs.map((l) => { try { return decodeEventLog({ abi: SAFE_FACTORY.abi, ...l }) as { eventName: string; args: { proxy: Address } }; } catch { return null; } }).find((e) => e?.eventName === "ProxyCreation")!.args.proxy;
    await test.setStorageAt({ address: USDC, index: keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [safe, USDC_BALANCE_SLOT])), value: toHex(1_000_000n, { size: 32 }) });
    const init = encodeFunctionData({ abi: ROLES_ABI, functionName: "setUp", args: [encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "address" }], [safe, safe, safe])] });
    const d = await pub.waitForTransactionReceipt({ hash: await wallet.writeContract({ address: ZODIAC.moduleProxyFactory, abi: MODULE_FACTORY_ABI, functionName: "deployModule", args: [ZODIAC.rolesV2Mastercopy, init, 5n] }) });
    roles = d.logs.map((l) => { try { return decodeEventLog({ abi: MODULE_FACTORY_ABI, ...l }); } catch { return null; } }).find((e) => e?.eventName === "ModuleProxyCreation")!.args.proxy as Address;
    await safeExec(safe, encodeFunctionData({ abi: SAFE_ABI, functionName: "enableModule", args: [roles] }));
  }, 180_000);

  afterAll(() => { anvil?.kill(); });

  for (const c of CUSTODIANS) {
    it.skipIf(!c.available())(`${c.name}: signs the agent's top-ups through Roles, and Roles still bounds them`, async () => {
      const account = await c.account();
      const role = `custody-${c.name.toLowerCase().replace(/\W+/g, "-")}`;
      const payer = privateKeyToAccount(generatePrivateKey()); // the agent's payer for one vendor
      const merchant = { origin: "https://vendor.example", payTo: attacker, network: "eip155:8453", maxPerTx: 50_000n };
      for (const call of agentPayRoleCalls({ roles, usdc: USDC, agent: account.address, role, payers: [payer.address], cap: CAP })) await safeExec(call.to, call.data);
      await test.setBalance({ address: account.address, value: 10n ** 17n }); // gas, on the fork only

      // The SDK's funding hook, with the custodian's account as the agent: the custodian signs, the fork executes.
      const before = await pub.getBlockNumber();
      const fund = rolesFunder({ agent: createWalletClient({ chain: CHAIN, transport, account }), publicClient: pub as never, roles, usdc: USDC, role, tranche: TRANCHE, confirmations: 1 });
      await fund(payer, merchant, 10_000n);
      expect(await bal(payer.address)).toBe(TRANCHE);
      const sent = [];
      for (let n = before + 1n; n <= (await pub.getBlockNumber()); n++) {
        for (const tx of (await pub.getBlock({ blockNumber: n, includeTransactions: true })).transactions) {
          if (tx.from.toLowerCase() === account.address.toLowerCase()) sent.push(tx);
        }
      }
      expect(sent).toHaveLength(1);
      expect(sent[0]!.to?.toLowerCase()).toBe(roles.toLowerCase());
      expect((sent[0] as { chainId?: number }).chainId).toBe(31337); // signed for the fork, not for Base

      // Roles still decides: the custodian's key can't pay anyone else.
      const toAttacker = await pub.simulateContract({
        address: roles, abi: ROLES_ABI, functionName: "execTransactionWithRole",
        args: [USDC, 0n, encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [attacker, 1_000n] }), 0, roleKey(role), true], account: account.address,
      }).then(() => "ALLOWED", (e) => { const x = (e as BaseError).walk((y) => y instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null; return x?.data?.errorName === "ConditionViolation" ? ROLES_STATUS[Number(x.data.args![0])] : String(x?.data?.errorName ?? e); });
      expect(toAttacker).toBe("ParameterNotAllowed");

      // And a revoke stops it: the next top-up is refused before the custodian is asked to sign anything.
      await safeExec(...(Object.values(revokeAgentCalls({ roles, agent: account.address, role })[0]!) as [Address, Hex]));
      const emptyPayer = privateKeyToAccount(generatePrivateKey());
      const revoked = await fund(emptyPayer, merchant, 10_000n).then(() => "FUNDED", (e) => (e instanceof PaymentDeniedError ? `${e.code}: ${e.reasons[0]}` : String(e).slice(0, 160)));
      expect(revoked).toMatch(/^policy_denied: .*NoMembership/);
      console.log(`${c.name}: agent ${account.address} topped up its payer through Roles (tx ${sent[0]!.hash.slice(0, 12)}…); to the attacker: ${toAttacker}; after revoke: ${revoked}`);
    });
  }
});
