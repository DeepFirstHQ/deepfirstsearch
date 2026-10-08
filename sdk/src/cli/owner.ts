import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  erc20Abi,
  formatUnits,
  getAddress,
  hexToBytes,
  http,
  isAddress,
  keccak256,
  parseUnits,
  toHex,
  type Address,
  type Chain,
  type Hex,
  type LocalAccount,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";
import { BUDGET_VAULT_FACTORY_ABI, BUDGET_VAULT_FULL_ABI } from "../contracts/abi.js";
import { AGENT_SAFE } from "../contracts/deployments.js";
import { burnerAddress } from "../wallet/burner.js";
import { signIntent, type Intent } from "../wallet/intent.js";
import { decryptKeystore } from "./keystore.js";

export type Io = {
  out: (s: string) => void;
  err: (s: string) => void;
  /** Asks a question on the terminal; `hidden` for passwords. Absent when not interactive. */
  ask?: (q: string, hidden?: boolean) => Promise<string>;
};

const USAGE = `agent-pay owner <command> [options]

Commands
  create-vault  [--delay 3600] [--salt default]          create your BudgetVault (CREATE2, idempotent)
  fund          --vault 0x… --amount 1.00                 send USDC from the owner to the vault
  budget        --vault 0x… --merchant 0x… --agent 0x… --per-tx 0.05 --per-day 0.50
                [--tranche-cap <per-tx>] [--days 30] [--period-hours 24] [--burner 0x…]
                                                          sign and propose a budget (active after the timelock)
  status        --vault 0x… [--intent 0x…]                balances, budgets, spend, activation
  pause | unpause --vault 0x…                             stop or resume all agent spending
  revoke        --vault 0x… --intent 0x…                  revoke one budget, instantly
  withdraw      --vault 0x… --amount 1.00 [--to 0x…]      take USDC out (default: to the owner)
  flush-fees    --vault 0x…                               pay fees the vault still owes

Options
  --network base-sepolia | base   (default base-sepolia)
  --rpc <url>  --factory 0x…  --usdc 0x…   custom RPC or deployment
  --keystore <path>   owner key from a Foundry/geth keystore (password: prompt or AGENT_PAY_KEYSTORE_PASSWORD)
                      or set AGENT_PAY_OWNER_KEY. Keys are never accepted as arguments.
  --yes   skip the confirmation    --json   machine-readable output

The burner (payer) for each merchant is derived from AGENT_PAY_BURNER_SEED, the same seed the agent's SDK uses.`;

const usdc = (v: bigint) => `${formatUnits(v, 6)} USDC`;

function amount(v: string | undefined, name: string): bigint {
  if (!v || !/^\d+(\.\d{1,6})?$/.test(v)) throw new Error(`--${name} must be a USDC amount like 0.05`);
  const a = parseUnits(v, 6);
  if (a <= 0n) throw new Error(`--${name} must be positive`);
  return a;
}
function addr(v: string | undefined, name: string): Address {
  if (!v || !isAddress(v, { strict: false })) throw new Error(`--${name} must be an address`);
  return getAddress(v);
}

type Ctx = {
  chain: Chain;
  factory: Address;
  usdc: Address;
  beta: boolean;
  explorer?: string;
  pub: ReturnType<typeof createPublicClient>;
  rpc: string;
};

async function context(v: Record<string, string | boolean | string[] | undefined>): Promise<Ctx> {
  const net = (v.network as string) ?? "base-sepolia";
  if (net !== "base" && net !== "base-sepolia") throw new Error("--network must be base or base-sepolia");
  const d = AGENT_SAFE[net];
  const rpc = (v.rpc as string) ?? (net === "base" ? "https://mainnet.base.org" : "https://sepolia.base.org");
  let chain: Chain = net === "base" ? base : baseSepolia;
  const probe = createPublicClient({ transport: http(rpc) });
  const chainId = await probe.getChainId();
  if (chainId !== d.chainId) {
    if (!v.factory || !v.usdc) throw new Error(`RPC is chain ${chainId}, not ${net}: pass --factory and --usdc for a custom deployment`);
    chain = defineChain({ id: chainId, name: `chain-${chainId}`, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
  }
  return {
    chain,
    rpc,
    factory: v.factory ? addr(v.factory as string, "factory") : d.factory,
    usdc: v.usdc ? addr(v.usdc as string, "usdc") : d.usdc,
    beta: chainId === 8453 && d.beta,
    ...(chainId === d.chainId ? { explorer: d.explorer } : {}),
    // Public RPCs rate-limit bursts: batch reads into one Multicall3 call where the chain has it, and retry.
    pub: createPublicClient({
      chain,
      transport: http(rpc, { retryCount: 4, retryDelay: 400 }),
      pollingInterval: 250,
      ...(chain.contracts?.multicall3 ? { batch: { multicall: true } } : {}),
    }),
  };
}

async function ownerAccount(v: Record<string, unknown>, env: NodeJS.ProcessEnv, io: Io): Promise<LocalAccount> {
  if (v.keystore) {
    let pw = env.AGENT_PAY_KEYSTORE_PASSWORD;
    if (pw === undefined) {
      if (!io.ask) throw new Error("set AGENT_PAY_KEYSTORE_PASSWORD or run interactively");
      pw = await io.ask("Keystore password: ", true);
    }
    return privateKeyToAccount(decryptKeystore(v.keystore as string, pw));
  }
  const k = env.AGENT_PAY_OWNER_KEY;
  if (!k || !/^0x[0-9a-fA-F]{64}$/.test(k)) throw new Error("owner key needed: --keystore <path> or AGENT_PAY_OWNER_KEY");
  return privateKeyToAccount(k as Hex);
}

// Intents proposed from this machine, so `status` can list them without scanning logs.
function stateFile(env: NodeJS.ProcessEnv) {
  const dir = env.AGENT_PAY_HOME ?? join(homedir(), ".agent-pay");
  return join(dir, "intents.json");
}
function loadIntents(env: NodeJS.ProcessEnv): Record<string, Hex[]> {
  const f = stateFile(env);
  return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as Record<string, Hex[]>) : {};
}
function saveIntent(env: NodeJS.ProcessEnv, chainId: number, vault: Address, id: Hex) {
  const f = stateFile(env);
  const all = loadIntents(env);
  const key = `${chainId}:${vault.toLowerCase()}`;
  all[key] = [...new Set([...(all[key] ?? []), id])];
  mkdirSync(join(f, ".."), { recursive: true, mode: 0o700 });
  writeFileSync(f, JSON.stringify(all, null, 2), { mode: 0o600 });
}

export async function ownerCli(argv: string[], env: NodeJS.ProcessEnv, io: Io): Promise<number> {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "help" || cmd === "--help") {
    io.out(USAGE);
    return cmd ? 0 : 1;
  }
  const { values: v } = parseArgs({
    args: rest,
    strict: true,
    options: {
      network: { type: "string" }, rpc: { type: "string" }, factory: { type: "string" }, usdc: { type: "string" },
      keystore: { type: "string" }, yes: { type: "boolean" }, json: { type: "boolean" },
      vault: { type: "string" }, amount: { type: "string" }, to: { type: "string" }, delay: { type: "string" }, salt: { type: "string" },
      merchant: { type: "string" }, agent: { type: "string" }, "per-tx": { type: "string" }, "per-day": { type: "string" },
      "tranche-cap": { type: "string" }, days: { type: "string" }, "period-hours": { type: "string" }, burner: { type: "string" },
      intent: { type: "string", multiple: true },
    },
  });
  const ctx = await context(v);
  const print = (human: string, data: Record<string, unknown>) =>
    io.out(v.json ? JSON.stringify(data, (_, x) => (typeof x === "bigint" ? x.toString() : x)) : human);
  const link = (tx: Hex) => (ctx.explorer ? `${ctx.explorer}/tx/${tx}` : tx);

  const confirm = async (summary: string) => {
    if (ctx.beta) io.err("Base mainnet: Agent Safe is an unaudited beta. Keep amounts small.");
    io.err(summary);
    if (v.yes) return;
    if (!io.ask) throw new Error("not interactive: pass --yes to confirm");
    if (!/^y(es)?$/i.test((await io.ask("Send this transaction? [y/N] ")).trim())) throw new Error("cancelled");
  };

  const owner = cmd === "status" ? undefined : await ownerAccount(v, env, io);
  const wallet = owner ? createWalletClient({ chain: ctx.chain, transport: http(ctx.rpc, { retryCount: 4, retryDelay: 400 }), account: owner }) : undefined;
  const send = async (req: Parameters<NonNullable<typeof wallet>["writeContract"]>[0]) => {
    const hash = await wallet!.writeContract(req);
    const r = await ctx.pub.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error(`transaction reverted: ${link(hash)}`);
    return hash;
  };
  const vaultArg = () => addr(v.vault, "vault");
  const isOwner = async (vault: Address) => {
    const o = await ctx.pub.readContract({ address: vault, abi: BUDGET_VAULT_FULL_ABI, functionName: "OWNER" });
    if (getAddress(o) !== owner!.address) throw new Error(`you (${owner!.address}) are not this vault's owner (${o})`);
  };

  switch (cmd) {
    case "create-vault": {
      const delay = Number(v.delay ?? 3600);
      if (!Number.isInteger(delay) || delay < 3600 || delay > 7 * 86400) throw new Error("--delay must be 3600..604800 seconds");
      const salt = keccak256(toHex((v.salt as string) ?? "default"));
      const vault = await ctx.pub.readContract({ address: ctx.factory, abi: BUDGET_VAULT_FACTORY_ABI, functionName: "predict", args: [owner!.address, salt, delay] });
      if ((await ctx.pub.getCode({ address: vault })) !== undefined) {
        print(`Vault already exists: ${vault}`, { vault, created: false });
        return 0;
      }
      await confirm(`Create a BudgetVault for owner ${owner!.address} with a ${delay / 3600} h timelock at ${vault}.`);
      const tx = await send({ address: ctx.factory, abi: BUDGET_VAULT_FACTORY_ABI, functionName: "create", args: [owner!.address, salt, delay], account: owner!, chain: ctx.chain });
      print(`Vault created: ${vault}\n${link(tx)}`, { vault, created: true, tx });
      return 0;
    }
    case "fund": {
      const vault = vaultArg();
      const a = amount(v.amount, "amount");
      await confirm(`Send ${usdc(a)} from ${owner!.address} to vault ${vault}.`);
      const tx = await send({ address: ctx.usdc, abi: erc20Abi, functionName: "transfer", args: [vault, a], account: owner!, chain: ctx.chain });
      print(`Funded ${usdc(a)}\n${link(tx)}`, { vault, amount: a, tx });
      return 0;
    }
    case "budget": {
      const vault = vaultArg();
      await isOwner(vault);
      const merchant = addr(v.merchant, "merchant");
      const agent = addr(v.agent, "agent");
      const perTx = amount(v["per-tx"], "per-tx");
      const perDay = amount(v["per-day"], "per-day");
      const trancheCap = v["tranche-cap"] ? amount(v["tranche-cap"], "tranche-cap") : perTx;
      if (perTx > perDay) throw new Error("--per-tx cannot exceed --per-day");
      if (trancheCap < perTx) io.err("Note: --tranche-cap is below --per-tx, so a payer can never hold one full payment.");
      const days = Number(v.days ?? 30);
      const periodHours = Number(v["period-hours"] ?? 24);
      if (!(days > 0 && days <= 365) || !(periodHours > 0 && periodHours <= 24 * 30)) throw new Error("--days must be 1..365 and --period-hours 1..720");
      let burner: Address;
      if (v.burner) burner = addr(v.burner, "burner");
      else {
        const seed = env.AGENT_PAY_BURNER_SEED;
        if (!seed || !/^0x[0-9a-fA-F]{64,}$/.test(seed)) throw new Error("set AGENT_PAY_BURNER_SEED (the agent SDK's payer seed) or pass --burner");
        burner = burnerAddress({ ownerSeed: hexToBytes(seed as Hex), vault, chainId: ctx.chain.id, counterparty: merchant });
      }
      const block = await ctx.pub.getBlock();
      const intent: Intent = {
        agent, counterparty: merchant, burner, token: ctx.usdc,
        maxPerTx: perTx, maxPerPeriod: perDay, trancheCap,
        period: Math.round(periodHours * 3600), validAfter: 0n,
        expiry: block.timestamp + BigInt(Math.round(days * 86400)),
        nonce: BigInt(keccak256(toHex(`${Date.now()}-${Math.random()}`))) >> 64n,
      };
      const delay = await ctx.pub.readContract({ address: vault, abi: BUDGET_VAULT_FULL_ABI, functionName: "activationDelay" });
      await confirm(
        `Budget for agent ${agent}\n  pays only ${merchant} (payer ${burner})\n  ≤ ${usdc(perTx)} per payment, ≤ ${usdc(perDay)} per ${periodHours} h, payer holds ≤ ${usdc(trancheCap)}\n` +
          `  expires in ${days} days; active ${delay / 3600} h after it is proposed`,
      );
      const signature = await signIntent(owner!, vault, ctx.chain.id, intent);
      const { result: id, request } = await ctx.pub.simulateContract({ address: vault, abi: BUDGET_VAULT_FULL_ABI, functionName: "proposeIntent", args: [intent, signature] as never, account: owner! }); // older viem (e.g. 2.38, pulled in by AgentKit) infers this tuple arg as never
      const tx = await send(request);
      const st = await ctx.pub.readContract({ address: vault, abi: BUDGET_VAULT_FULL_ABI, functionName: "getIntent", args: [id] });
      saveIntent(env, ctx.chain.id, vault, id);
      const activeAt = new Date(Number(st.activeAt) * 1000).toISOString();
      const mcp = { payTo: merchant, intentId: id, maxPerTx: formatUnits(perTx, 6), maxSpend: formatUnits(perDay, 6) };
      print(
        `Budget proposed: ${id}\nActive at ${activeAt}\n${link(tx)}\n\nFor the MCP server config (merchants[]):\n${JSON.stringify(mcp, null, 2)}`,
        { intentId: id, activeAt: st.activeAt, burner, tx },
      );
      return 0;
    }
    case "status": {
      const vault = vaultArg();
      const [o, paused, delay, owedJar, owedOps, bal] = await Promise.all([
        ctx.pub.readContract({ address: vault, abi: BUDGET_VAULT_FULL_ABI, functionName: "OWNER" }),
        ctx.pub.readContract({ address: vault, abi: BUDGET_VAULT_FULL_ABI, functionName: "paused" }),
        ctx.pub.readContract({ address: vault, abi: BUDGET_VAULT_FULL_ABI, functionName: "activationDelay" }),
        ctx.pub.readContract({ address: vault, abi: BUDGET_VAULT_FULL_ABI, functionName: "owedJar" }),
        ctx.pub.readContract({ address: vault, abi: BUDGET_VAULT_FULL_ABI, functionName: "owedOps" }),
        ctx.pub.readContract({ address: ctx.usdc, abi: erc20Abi, functionName: "balanceOf", args: [vault] }),
      ]);
      const ids = [...new Set([...(loadIntents(env)[`${ctx.chain.id}:${vault.toLowerCase()}`] ?? []), ...((v.intent as string[] | undefined) ?? [])])] as Hex[];
      const now = (await ctx.pub.getBlock()).timestamp;
      const intents = [];
      for (const id of ids) {
        const s = await ctx.pub.readContract({ address: vault, abi: BUDGET_VAULT_FULL_ABI, functionName: "getIntent", args: [id] });
        if (s.activeAt === 0n) continue;
        const payerBal = await ctx.pub.readContract({ address: ctx.usdc, abi: erc20Abi, functionName: "balanceOf", args: [s.intent.burner] });
        const state = s.revoked ? "revoked" : now >= s.intent.expiry ? "expired" : now < s.activeAt ? `pending until ${new Date(Number(s.activeAt) * 1000).toISOString()}` : "active";
        // Same window rule as BudgetVault._spend: windows count from activeAt.
        const spent = now >= s.activeAt && s.windowIdx === (now - s.activeAt) / BigInt(s.intent.period) ? s.spentInWindow : 0n;
        intents.push({ id, state, merchant: s.intent.counterparty, agent: s.intent.agent, payer: s.intent.burner, payerBalance: payerBal, perTx: s.intent.maxPerTx, perPeriod: s.intent.maxPerPeriod, spentThisPeriod: spent, expiry: s.intent.expiry });
      }
      const lines = [
        `Vault ${vault}`,
        `  owner ${o}${paused ? "   PAUSED" : ""}`,
        `  balance ${usdc(bal)}${owedJar + owedOps > 0n ? ` (owes ${usdc(owedJar + owedOps)} in fees: run flush-fees)` : ""}`,
        `  timelock ${delay / 3600} h`,
        ...(intents.length ? intents.map((i) => `  budget ${i.id.slice(0, 10)}… ${i.state}\n    pays ${i.merchant} via payer ${i.payer} (holds ${usdc(i.payerBalance)})\n    ≤ ${usdc(i.perTx)} per payment, spent ${usdc(i.spentThisPeriod)} of ${usdc(i.perPeriod)} this period`) : ["  no budgets known on this machine (pass --intent 0x…)"]),
      ];
      print(lines.join("\n"), { vault, owner: o, paused, balance: bal, owedJar, owedOps, activationDelay: delay, intents });
      return 0;
    }
    case "pause":
    case "unpause": {
      const vault = vaultArg();
      await isOwner(vault);
      await confirm(`${cmd === "pause" ? "Pause all agent spending" : "Resume agent spending"} on ${vault}.`);
      const tx = await send({ address: vault, abi: BUDGET_VAULT_FULL_ABI, functionName: "setPaused", args: [cmd === "pause"], account: owner!, chain: ctx.chain });
      print(`${cmd === "pause" ? "Paused" : "Resumed"}\n${link(tx)}`, { vault, paused: cmd === "pause", tx });
      return 0;
    }
    case "revoke": {
      const vault = vaultArg();
      await isOwner(vault);
      const id = (v.intent as string[] | undefined)?.[0];
      if (!id || !/^0x[0-9a-fA-F]{64}$/.test(id)) throw new Error("--intent must be a budget id (0x + 64 hex)");
      await confirm(`Revoke budget ${id} on ${vault}.`);
      const tx = await send({ address: vault, abi: BUDGET_VAULT_FULL_ABI, functionName: "revokeIntent", args: [id as Hex], account: owner!, chain: ctx.chain });
      print(`Revoked ${id}\n${link(tx)}`, { vault, intentId: id, tx });
      return 0;
    }
    case "withdraw": {
      const vault = vaultArg();
      await isOwner(vault);
      const a = amount(v.amount, "amount");
      const to = v.to ? addr(v.to, "to") : owner!.address;
      await confirm(`Withdraw ${usdc(a)} from ${vault} to ${to}.`);
      const tx = await send({ address: vault, abi: BUDGET_VAULT_FULL_ABI, functionName: "withdraw", args: [to, a], account: owner!, chain: ctx.chain });
      print(`Withdrew ${usdc(a)} to ${to}\n${link(tx)}`, { vault, to, amount: a, tx });
      return 0;
    }
    case "flush-fees": {
      const vault = vaultArg();
      await confirm(`Pay the fees ${vault} owes to the FeeJar and OPS.`);
      const tx = await send({ address: vault, abi: BUDGET_VAULT_FULL_ABI, functionName: "flushFees", account: owner!, chain: ctx.chain });
      print(`Fees flushed\n${link(tx)}`, { vault, tx });
      return 0;
    }
    default:
      io.err(`unknown command ${cmd}\n\n${USAGE}`);
      return 1;
  }
}
