/**
 * On-chain monitor for an Agent Safe deployment. Scans recent blocks and reports activity; exits with code 1 on
 * anything that needs a human (releaser proposals, fees that could not be delivered, unusually large movements).
 *
 *   RPC_URL=https://mainnet.base.org FACTORY=0x… FEE_JAR=0x… FROM_BLOCK=<factory deploy block> \
 *   LOOKBACK_BLOCKS=12000 LARGE_USDC=100000000 npx tsx scripts/monitor.ts
 *
 * Designed to run on a schedule (see .github/workflows/monitor.yml): a failing run emails the maintainers.
 */
import { createPublicClient, http, parseAbiItem, formatUnits, type Address, type Log } from "viem";

const env = (k: string, d?: string) => {
  const v = process.env[k] ?? d;
  if (v === undefined || v === "") throw new Error(`missing env ${k}`);
  return v;
};
const client = createPublicClient({ transport: http(env("RPC_URL")) });
const FACTORY = env("FACTORY") as Address;
const FEE_JAR = env("FEE_JAR") as Address;
const FROM = BigInt(env("FROM_BLOCK"));
const LOOKBACK = BigInt(env("LOOKBACK_BLOCKS", "12000")); // ~6.7 h on Base
const LARGE = BigInt(env("LARGE_USDC", "100000000")); // 100 USDC, 6 decimals
const CHUNK = BigInt(env("LOG_CHUNK", "500")); // public Base RPCs cap eth_getLogs at 500 blocks

const E = {
  vaultCreated: parseAbiItem("event VaultCreated(address indexed owner, address vault, bytes32 salt)"),
  paid: parseAbiItem("event Paid(bytes32 indexed id, address indexed to, uint256 amount, uint256 fee)"),
  funded: parseAbiItem("event BurnerFunded(bytes32 indexed id, address indexed burner, uint256 amount, uint256 fee)"),
  withdrawn: parseAbiItem("event Withdrawn(address indexed to, uint256 amount)"),
  deferred: parseAbiItem("event FeeDeferred(address indexed recipient, uint256 amount)"),
  proposed: parseAbiItem("event ReleaserProposed(address indexed releaser, address indexed depth, uint64 eta)"),
  set: parseAbiItem("event ReleaserSet(address indexed releaser)"),
};

async function logs<T>(address: Address | Address[] | undefined, event: T, from: bigint, to: bigint) {
  const out: Log[] = [];
  for (let a = from; a <= to; a += CHUNK) {
    const b = a + CHUNK - 1n > to ? to : a + CHUNK - 1n;
    out.push(...(await client.getLogs({ address, event: event as never, fromBlock: a, toBlock: b })));
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

  for (const l of await logs(FEE_JAR, E.proposed, since, head)) alerts.push(`FeeJar releaser PROPOSED: ${l.args.releaser} for token ${l.args.depth}, eta ${l.args.eta} (tx ${l.transactionHash})`);
  for (const l of await logs(FEE_JAR, E.set, since, head)) alerts.push(`FeeJar releaser SET: ${l.args.releaser} (tx ${l.transactionHash})`);

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
  if (alerts.length) process.exit(1);
}

await main();
