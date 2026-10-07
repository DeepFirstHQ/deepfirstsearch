/**
 * On-chain monitor for an Agent Safe deployment. Scans recent blocks and reports activity; exits with code 1 on
 * anything that needs a human (releaser proposals, fees that could not be delivered, unusually large movements).
 *
 *   RPC_URL=https://mainnet.base.org FACTORY=0x… FEE_JAR=0x… FROM_BLOCK=<factory deploy block> \
 *   LOOKBACK_BLOCKS=12000 LARGE_USDC=100000000 npx tsx scripts/monitor.ts
 *
 * Designed to run on a schedule (see .github/workflows/monitor.yml): a failing run emails the maintainers.
 * Optionally also sends alerts to Telegram and/or Discord (see scripts/notify.ts).
 */
import { createPublicClient, fallback, getAbiItem, http, parseAbiItem, formatUnits, type Address, type Log } from "viem";
import { BUDGET_VAULT_FACTORY_ABI, BUDGET_VAULT_FULL_ABI, FEE_JAR_ABI } from "../src/contracts/abi.js";
import { notify } from "./notify.js";

const env = (k: string, d?: string) => {
  const v = process.env[k] ?? d;
  if (v === undefined || v === "") throw new Error(`missing env ${k}`);
  return v;
};
// Comma-separated RPC list: shared CI IPs get rate-limited by public RPCs, so retry and fall back to the next one.
const RPCS = env("RPC_URL").split(",").map((u) => u.trim()).filter(Boolean);
const client = createPublicClient({ transport: fallback(RPCS.map((u) => http(u, { retryCount: 4, retryDelay: 800 }))) });
const pause = () => new Promise((r) => setTimeout(r, Number(process.env.LOG_PAUSE_MS ?? 150)));
const FACTORY = env("FACTORY") as Address;
const FEE_JAR = env("FEE_JAR") as Address;
const FROM = BigInt(env("FROM_BLOCK"));
const LOOKBACK = BigInt(env("LOOKBACK_BLOCKS", "12000")); // ~6.7 h on Base
const LARGE = BigInt(env("LARGE_USDC", "100000000")); // 100 USDC, 6 decimals
const CHUNK = BigInt(env("LOG_CHUNK", "500")); // public Base RPCs cap eth_getLogs at 500 blocks

// Event definitions come from the compiled contracts, so they can never drift from what the contracts emit.
const E = {
  vaultCreated: getAbiItem({ abi: BUDGET_VAULT_FACTORY_ABI, name: "VaultCreated" }),
  paid: getAbiItem({ abi: BUDGET_VAULT_FULL_ABI, name: "Paid" }),
  funded: getAbiItem({ abi: BUDGET_VAULT_FULL_ABI, name: "BurnerFunded" }),
  withdrawn: getAbiItem({ abi: BUDGET_VAULT_FULL_ABI, name: "Withdrawn" }),
  deferred: getAbiItem({ abi: BUDGET_VAULT_FULL_ABI, name: "FeeDeferred" }),
  proposed: getAbiItem({ abi: FEE_JAR_ABI, name: "ReleaserProposed" }),
  cancelled: getAbiItem({ abi: FEE_JAR_ABI, name: "ReleaserCancelled" }),
  set: getAbiItem({ abi: FEE_JAR_ABI, name: "ReleaserSet" }),
};

async function logs<T>(address: Address | Address[] | undefined, event: T, from: bigint, to: bigint) {
  const out: Log[] = [];
  for (let a = from; a <= to; a += CHUNK) {
    const b = a + CHUNK - 1n > to ? to : a + CHUNK - 1n;
    out.push(...(await client.getLogs({ address, event: event as never, fromBlock: a, toBlock: b })));
    await pause();
  }
  return out as (Log & { args: Record<string, unknown> })[];
}

const usdc = (v: unknown) => `${formatUnits(v as bigint, 6)} USDC`;

async function main() {
  const head = await client.getBlockNumber();
  const since = head - LOOKBACK > FROM ? head - LOOKBACK : FROM;
  const alerts: string[] = [];
  const info: string[] = [];

  const created = await logs(FACTORY, E.vaultCreated, since, head);
  info.push(`new vaults in window: ${created.length}`);

  // Vault events from any address, kept only if the emitter is one of our vaults (it points at our FeeJar).
  const ours = new Map<Address, boolean>();
  const isOurVault = async (a: Address) => {
    if (!ours.has(a)) {
      const jar = await client.readContract({ address: a, abi: [parseAbiItem("function FEE_JAR() view returns (address)")], functionName: "FEE_JAR" }).catch(() => undefined);
      ours.set(a, jar?.toLowerCase() === FEE_JAR.toLowerCase());
    }
    return ours.get(a)!;
  };
  const vaultLogs = async (ev: unknown) => {
    const all = await logs(undefined, ev, since, head);
    const keep = [];
    for (const l of all) if (await isOurVault(l.address)) keep.push(l);
    return keep;
  };

  for (const l of await logs(FEE_JAR, E.proposed, since, head)) alerts.push(`FeeJar releaser PROPOSED: ${l.args.releaser} for token ${l.args.depth}, codehash ${l.args.codehash}, eta ${l.args.eta} (tx ${l.transactionHash})`);
  for (const l of await logs(FEE_JAR, E.set, since, head)) alerts.push(`FeeJar releaser SET: ${l.args.releaser} (tx ${l.transactionHash})`);
  for (const l of await logs(FEE_JAR, E.cancelled, since, head)) alerts.push(`FeeJar releaser proposal CANCELLED: ${l.args.releaser} (tx ${l.transactionHash})`);

  {
    let volume = 0n;
    for (const ev of [E.paid, E.funded]) {
      for (const l of await vaultLogs(ev)) {
        volume += l.args.amount as bigint;
        if ((l.args.amount as bigint) >= LARGE) alerts.push(`large ${ev.name} ${usdc(l.args.amount)} from ${l.address} (tx ${l.transactionHash})`);
      }
    }
    info.push(`spend volume in window: ${usdc(volume)}`);
    for (const l of await vaultLogs(E.withdrawn)) if ((l.args.amount as bigint) >= LARGE) info.push(`large withdrawal ${usdc(l.args.amount)} from ${l.address}`);
    for (const l of await vaultLogs(E.deferred)) alerts.push(`fee could not be delivered to ${l.args.recipient}: ${usdc(l.args.amount)} (blacklisted recipient?) tx ${l.transactionHash}`);
  }

  console.log(`blocks ${since}–${head}`);
  for (const i of info) console.log(`info: ${i}`);
  for (const a of alerts) console.log(`ALERT: ${a}`);
  for (const r of await notify(alerts, `blocks ${since}–${head}`, process.env)) console.log(`notify ${r}`);
  if (alerts.length) process.exit(1);
}

try {
  await main();
} catch (e) {
  // Not a security finding: the RPCs could not be reached even after retries and fallback.
  console.log(`MONITOR UNAVAILABLE (RPC): ${(e as Error).message.split("\n")[0]}`);
  process.exit(2);
}
