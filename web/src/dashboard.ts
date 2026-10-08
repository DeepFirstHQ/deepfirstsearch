// Read-only Agent Safe vault dashboard (issue #7). Everything comes from Base's public JSON-RPC endpoints; nothing is
// signed or sent. The DOM is built with createElement/textContent only (the site's CSP enforces Trusted Types).
import "./dashboard.css";
import {
  createPublicClient,
  decodeEventLog,
  erc20Abi,
  fallback,
  formatUnits,
  getAddress,
  http,
  isAddress,
  type Address,
  type Hex,
  type Log,
  type PublicClient,
} from "viem";
import { base, baseSepolia } from "viem/chains";
import { BUDGET_VAULT_FULL_ABI } from "../../sdk/src/contracts/abi";
import { AGENT_SAFE } from "../../sdk/src/contracts/deployments";

type NetKey = "base" | "base-sepolia";
// `wideWindow`: how far back from the head the publicnode endpoint serves 10,000-block log ranges without a token.
const NETS: Record<NetKey, { label: string; chain: typeof base | typeof baseSepolia; rpcs: string[]; since: bigint; wideWindow: bigint }> = {
  // `since`: the block the official factory was deployed at; no Agent Safe vault can be older.
  base: { label: "Base", chain: base, rpcs: ["https://mainnet.base.org", "https://base-rpc.publicnode.com"], since: 52261631n, wideWindow: 9_000n },
  "base-sepolia": {
    label: "Base Sepolia",
    chain: baseSepolia,
    rpcs: ["https://sepolia.base.org", "https://base-sepolia-rpc.publicnode.com"],
    since: 47764270n,
    wideWindow: 10n ** 12n, // serves the whole chain
  },
};
const LOG_SPAN = 500n; // base.org caps eth_getLogs at 500 blocks…
const WIDE_SPAN = 10_000n; // publicnode allows 10,000
const BATCH = 10; // …and at 10 calls per JSON-RPC batch
const BLOCK_SECONDS = 2n; // Base and Base Sepolia
const DAY_BLOCKS = 86_400n / BLOCK_SECONDS;
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef" as Hex; // Transfer(address,address,uint256)

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const form = $<HTMLFormElement>("form");
const vaultInput = $<HTMLInputElement>("vault");
const netSelect = $<HTMLSelectElement>("network");
const statusEl = $("status");
const out = $("out");

function el(tag: string, props: Record<string, string> = {}, ...kids: (Node | string | null | undefined)[]): HTMLElement {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") n.className = v;
    else n.setAttribute(k, v);
  }
  for (const k of kids) if (k !== null && k !== undefined) n.append(k);
  return n;
}
const usdc = (a: bigint) => `${formatUnits(a, 6)} USDC`;
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
function link(explorer: string, kind: "address" | "tx" | "block", v: string, text = kind === "address" ? short(v) : kind === "tx" ? short(v) : v) {
  const a = el("a", { href: `${explorer}/${kind}/${v}`, target: "_blank", rel: "noopener noreferrer" }, text);
  return a;
}
function status(text: string, kind: "info" | "error" = "info") {
  statusEl.textContent = text;
  statusEl.className = `status status--${kind}`;
}
function friendly(e: unknown): string {
  const m = String((e as Error)?.message ?? e);
  if (/429|rate|limit|Too Many/i.test(m)) return "The public RPC is rate-limiting this browser. Wait a minute and try again.";
  if (/fetch|network|Failed to fetch|timeout|took too long/i.test(m)) return "Couldn't reach Base's public RPC. Check your connection and try again.";
  return m.split("\n")[0]!.slice(0, 220);
}

/** Current-state reads (multicall), with the publicnode endpoint as a fallback. */
function client(net: NetKey): PublicClient {
  const n = NETS[net];
  return createPublicClient({
    chain: n.chain,
    batch: { multicall: true },
    transport: fallback(n.rpcs.map((u) => http(u, { retryCount: 3, retryDelay: 700 }))),
  }) as PublicClient;
}
/** Historical reads: only the base.org endpoint serves old blocks without a token, so no fallback here. */
function historyClient(net: NetKey): PublicClient {
  const n = NETS[net];
  return createPublicClient({ chain: n.chain, transport: http(n.rpcs[0], { retryCount: 6, retryDelay: 800 }) }) as PublicClient;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type RpcCall = { method: string; params: unknown[] };
/**
 * Up to 10 calls per HTTP request (the endpoint's batch limit), paced, retrying only the calls that came back
 * rate-limited, with backoff. Throws on any other error.
 */
async function rpcBatch(url: string, calls: RpcCall[]): Promise<unknown[]> {
  const results: unknown[] = new Array(calls.length);
  let pending = calls.map((c, i) => ({ ...c, i }));
  for (let attempt = 0; pending.length; attempt++) {
    if (attempt > 7) throw new Error("rate limit: the public RPC kept refusing requests");
    if (attempt) await sleep(600 * 2 ** (attempt - 1));
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(pending.map((c) => ({ jsonrpc: "2.0", id: c.i, method: c.method, params: c.params }))),
    });
    if (res.status === 429) continue;
    if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
    const body = (await res.json()) as { id: number; result?: unknown; error?: { message: string } }[] | { error?: { message: string } };
    if (!Array.isArray(body)) {
      if (/rate|limit/i.test(body.error?.message ?? "")) continue;
      throw new Error(body.error?.message ?? "unexpected RPC response");
    }
    const retry: typeof pending = [];
    for (const r of body) {
      const call = pending.find((c) => c.i === r.id)!;
      if (r.error) {
        if (/rate|limit|too many/i.test(r.error.message)) retry.push(call);
        else throw new Error(r.error.message);
      } else results[r.id] = r.result;
    }
    pending = retry;
  }
  return results;
}

/** The block the vault's code first appears in (binary search over historical eth_getCode). */
async function creationBlock(c: PublicClient, vault: Address, lo: bigint, hi: bigint): Promise<bigint> {
  while (hi - lo > 1n) {
    const mid = (lo + hi) / 2n;
    const code = await c.getCode({ address: vault, blockNumber: mid });
    if (code && code !== "0x") hi = mid;
    else lo = mid;
  }
  return hi;
}

const toHex = (n: bigint) => `0x${n.toString(16)}`;
// eth_getLogs returns hex quantities; the rest of the page works with bigint/number.
const normalize = (logs: Log[]) =>
  logs.map((l) => ({ ...l, blockNumber: BigInt(l.blockNumber as unknown as string), logIndex: Number(l.logIndex as unknown as string) })) as Log[];

/**
 * eth_getLogs over [from, to]. Newest first, in 10,000-block calls to the publicnode endpoint (which serves recent
 * blocks, and all of Base Sepolia, without a token); once it refuses a range, the rest goes to base.org in its
 * 500-block calls, 10 per HTTP request, paced.
 */
async function logsIn(net: NetKey, params: { address: Address; topics?: (Hex | null)[] }, from: bigint, to: bigint, onProgress: (share: number) => void) {
  const [baseOrg, publicnode] = NETS[net].rpcs as [string, string];
  const wideFloor = to > NETS[net].wideWindow ? to - NETS[net].wideWindow : 0n;
  const call = (f: bigint, t: bigint): RpcCall => ({ method: "eth_getLogs", params: [{ address: params.address, topics: params.topics, fromBlock: toHex(f), toBlock: toHex(t) }] });
  const logs: Log[] = [];
  const total = Number(to - from + 1n);
  let hi = to;
  let wide = true;
  while (hi >= from) {
    if (wide) {
      let lo = hi - WIDE_SPAN + 1n > from ? hi - WIDE_SPAN + 1n : from;
      if (lo < wideFloor) lo = wideFloor > from ? wideFloor : from;
      try {
        const [r] = await rpcBatch(publicnode, [call(lo, hi)]);
        logs.push(...(r as Log[]));
        hi = lo - 1n;
        onProgress(Number(to - hi) / total);
        if (hi < wideFloor) wide = false;
        continue;
      } catch {
        wide = false; // older blocks need base.org from here on
      }
    }
    const group: RpcCall[] = [];
    let lo = hi;
    for (let k = 0; k < BATCH && lo >= from; k++) {
      const l = lo - LOG_SPAN + 1n > from ? lo - LOG_SPAN + 1n : from;
      group.push(call(l, lo));
      lo = l - 1n;
    }
    for (const r of await rpcBatch(baseOrg, group)) logs.push(...(r as Log[]));
    hi = lo;
    onProgress(Number(to - hi) / total);
    await sleep(150);
  }
  return normalize(logs);
}

/** Per-browser cache of a vault's already-read history, so a second visit only reads new blocks. */
type Cached = { created: string; scannedTo: string; deposits?: CachedLog[]; depositsTo?: string; logs: { blockNumber: string; logIndex: number; transactionHash: Hex; data: Hex; topics: Hex[] }[] };
type CachedLog = Cached["logs"][number];
const toCached = (l: Log): CachedLog => ({ blockNumber: l.blockNumber!.toString(), logIndex: l.logIndex!, transactionHash: l.transactionHash!, data: l.data, topics: l.topics as Hex[] });
const fromCached = (l: CachedLog) => ({ ...l, blockNumber: BigInt(l.blockNumber) }) as unknown as Log;
const cacheKey = (net: NetKey, vault: Address) => `dfs-dashboard:${net}:${vault.toLowerCase()}`;
function readCache(net: NetKey, vault: Address): Cached | null {
  try {
    const v = localStorage.getItem(cacheKey(net, vault));
    return v ? (JSON.parse(v) as Cached) : null;
  } catch {
    return null;
  }
}
function writeCache(net: NetKey, vault: Address, created: bigint, scannedTo: bigint, logs: Log[], deposits: Log[]) {
  try {
    const c: Cached = { created: created.toString(), scannedTo: scannedTo.toString(), logs: logs.map(toCached), deposits: deposits.map(toCached), depositsTo: scannedTo.toString() };
    localStorage.setItem(cacheKey(net, vault), JSON.stringify(c));
  } catch {
    // private mode or full storage: the page works without the cache
  }
}

const padTopic = (a: Address) => `0x${a.slice(2).toLowerCase().padStart(64, "0")}` as Hex;

async function show(vaultRaw: string, net: NetKey) {
  out.hidden = true;
  if (!isAddress(vaultRaw.trim(), { strict: false })) return status("That isn't an address: expected 0x followed by 40 hex characters.", "error");
  const vault = getAddress(vaultRaw.trim());
  const dep = AGENT_SAFE[net];
  const c = client(net);
  const explorer = dep.explorer;
  history.replaceState(null, "", `?vault=${vault}${net === "base" ? "" : `&network=${net}`}`);

  status(`Reading ${short(vault)} on ${NETS[net].label}…`);
  const head = await c.getBlock();
  const code = await c.getCode({ address: vault });
  if (!code || code === "0x") return status(`No contract at ${vault} on ${NETS[net].label}. Is it the right network?`, "error");

  let core;
  try {
    core = await c.multicall({
      allowFailure: false,
      contracts: [
        { address: vault, abi: BUDGET_VAULT_FULL_ABI, functionName: "OWNER" },
        { address: vault, abi: BUDGET_VAULT_FULL_ABI, functionName: "paused" },
        { address: vault, abi: BUDGET_VAULT_FULL_ABI, functionName: "activationDelay" },
        { address: vault, abi: BUDGET_VAULT_FULL_ABI, functionName: "pendingDelay" },
        { address: vault, abi: BUDGET_VAULT_FULL_ABI, functionName: "pendingDelayEta" },
        { address: vault, abi: BUDGET_VAULT_FULL_ABI, functionName: "owedJar" },
        { address: vault, abi: BUDGET_VAULT_FULL_ABI, functionName: "owedOps" },
        { address: vault, abi: BUDGET_VAULT_FULL_ABI, functionName: "USDC" },
        { address: vault, abi: BUDGET_VAULT_FULL_ABI, functionName: "FEE_JAR" },
        { address: dep.usdc, abi: erc20Abi, functionName: "balanceOf", args: [vault] },
      ],
    });
  } catch {
    return status(`${vault} is a contract, but not an Agent Safe vault (it doesn't answer the vault's read functions).`, "error");
  }
  const [owner, paused, delay, pendingDelay, pendingEta, owedJar, owedOps, token, feeJar, balance] = core;
  const official = getAddress(token) === getAddress(dep.usdc) && getAddress(feeJar) === getAddress(dep.feeJar);

  // Summary first: it is ready in a second, while the history below can take a while on Base mainnet.
  const summary = $("summary");
  summary.replaceChildren();
  const row = (k: string, ...v: (Node | string)[]) => summary.append(el("dt", {}, k), el("dd", {}, ...v));
  row("Vault", link(explorer, "address", vault, vault));
  row("Network", `${NETS[net].label}${dep.beta ? " · unaudited beta, keep amounts small" : ""}`);
  row("Deployment", official ? `matches the official ${dep.version} deployment (USDC and FeeJar)` : "does NOT match the official deployment's USDC/FeeJar: treat with care");
  row("Owner", link(explorer, "address", owner, owner));
  row("USDC balance", el("strong", {}, usdc(balance)));
  row("Status", paused ? el("span", { class: "pill pill--warn" }, "Paused: agents can't spend") : el("span", { class: "pill pill--ok" }, "Active"));
  row(
    "Timelock",
    `${Number(delay) / 3600} h before a new or raised budget becomes active`,
    pendingEta > 0n ? ` (change to ${Number(pendingDelay) / 3600} h queued for ${new Date(Number(pendingEta) * 1000).toISOString().replace(".000Z", "Z")})` : "",
  );
  if (owedJar + owedOps > 0n) row("Fees owed", `${usdc(owedJar + owedOps)} (anyone can run flush-fees)`);
  $("intents").replaceChildren(el("p", { class: "note" }, "Reading the vault's history…"));
  $("events").replaceChildren(el("p", { class: "note" }, "Reading the last 24 hours…"));
  out.hidden = false;

  // History: what this browser already read, plus the blocks since then.
  const cached = readCache(net, vault);
  let created: bigint;
  let fromBlock: bigint;
  let old: Log[] = [];
  if (cached) {
    created = BigInt(cached.created);
    fromBlock = BigInt(cached.scannedTo) + 1n;
    old = cached.logs.map(fromCached);
  } else {
    status("Finding when the vault was created…");
    created = await creationBlock(historyClient(net), vault, NETS[net].since, head.number);
    fromBlock = created;
  }
  const fresh = fromBlock <= head.number ? await logsIn(net, { address: vault }, fromBlock, head.number, (x) => status(`Reading the vault's history… ${Math.round(x * 100)}%`)) : [];
  const vaultLogs = [...old, ...fresh];
  const dayStart = head.number > DAY_BLOCKS ? head.number - DAY_BLOCKS : 0n;
  // Deposits (USDC sent to the vault) in the last 24 hours, again only the blocks not read yet.
  const depStart = [dayStart, created, cached?.depositsTo ? BigInt(cached.depositsTo) + 1n : 0n].reduce((m, x) => (x > m ? x : m));
  const depositLogs = [
    ...(cached?.deposits ?? []).map(fromCached).filter((l) => l.blockNumber! >= dayStart),
    ...(depStart <= head.number
      ? await logsIn(net, { address: dep.usdc, topics: [TRANSFER_TOPIC, null, padTopic(vault)] }, depStart, head.number, (x) =>
          status(`Reading deposits in the last 24 hours… ${Math.round(x * 100)}%`),
        )
      : []),
  ];
  writeCache(net, vault, created, head.number, vaultLogs, depositLogs);

  const decoded = vaultLogs
    .map((l) => {
      try {
        return { log: l, ev: decodeEventLog({ abi: BUDGET_VAULT_FULL_ABI, data: l.data, topics: l.topics as [Hex, ...Hex[]] }) };
      } catch {
        return null;
      }
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  // Budgets: every intent the vault has seen proposed, read back from the contract.
  const ids = [...new Set(decoded.filter((d) => d.ev.eventName === "IntentProposed").map((d) => (d.ev.args as { id: Hex }).id))];
  const states = ids.length
    ? await c.multicall({ allowFailure: false, contracts: ids.map((id) => ({ address: vault, abi: BUDGET_VAULT_FULL_ABI, functionName: "getIntent" as const, args: [id] as const })) })
    : [];
  const payerBalances = states.length
    ? await c.multicall({ allowFailure: false, contracts: states.map((s) => ({ address: dep.usdc, abi: erc20Abi, functionName: "balanceOf" as const, args: [s.intent.burner] as const })) })
    : [];

  row("Created", link(explorer, "block", created.toString()), ` · history read up to block ${head.number}${cached ? " (earlier blocks cached in this browser)" : ""}`);

  const now = head.timestamp;
  const intentsEl = $("intents");
  intentsEl.replaceChildren();
  if (!states.length) intentsEl.append(el("p", { class: "note" }, "No budgets proposed on this vault yet."));
  else {
    const table = el("table", { class: "grid" });
    table.append(el("thead", {}, el("tr", {}, ...["Pays (merchant)", "Via payer", "Agent", "Per payment", "Spent this period", "Tranche cap", "State"].map((h) => el("th", {}, h)))));
    const tb = el("tbody");
    states.forEach((s, i) => {
      const it = s.intent;
      const state = s.revoked ? "revoked" : now >= it.expiry ? "expired" : now < s.activeAt ? "pending" : "active";
      // Same window rule as BudgetVault._spend: windows count from activeAt.
      const spent = now >= s.activeAt && s.windowIdx === (now - s.activeAt) / BigInt(it.period) ? s.spentInWindow : 0n;
      const periodH = it.period / 3600;
      const stateText =
        state === "pending" ? `pending until ${new Date(Number(s.activeAt) * 1000).toISOString().replace(".000Z", "Z")}` :
        state === "active" ? `active since ${new Date(Number(s.activeAt) * 1000).toISOString().slice(0, 10)}` : state;
      tb.append(
        el(
          "tr",
          { title: `budget ${ids[i]}` },
          el("td", {}, link(explorer, "address", it.counterparty)),
          el("td", {}, link(explorer, "address", it.burner), el("div", { class: "sub" }, `holds ${usdc(payerBalances[i]!)}`)),
          el("td", {}, link(explorer, "address", it.agent)),
          el("td", {}, usdc(it.maxPerTx)),
          el("td", {}, `${usdc(spent)} of ${usdc(it.maxPerPeriod)}`, el("div", { class: "sub" }, `per ${periodH % 24 === 0 ? `${periodH / 24} d` : `${periodH} h`}`)),
          el("td", {}, usdc(it.trancheCap)),
          el("td", {}, el("span", { class: `pill ${state === "active" ? "pill--ok" : state === "pending" ? "pill--info" : "pill--warn"}` }, stateText)),
        ),
      );
    });
    table.append(tb);
    intentsEl.append(el("div", { class: "scroll" }, table));
  }

  type Item = { block: bigint; index: number; tx: Hex; what: string; detail: (Node | string)[] };
  const items: Item[] = [];
  for (const { log, ev } of decoded) {
    if ((log.blockNumber ?? 0n) < dayStart) continue;
    const a = ev.args as Record<string, unknown>;
    const it = (what: string, ...detail: (Node | string)[]) => items.push({ block: log.blockNumber!, index: log.logIndex!, tx: log.transactionHash!, what, detail });
    switch (ev.eventName) {
      case "BurnerFunded": it("Payer topped up", `${usdc(a.amount as bigint)} to `, link(explorer, "address", a.burner as string), ` (fee ${usdc(a.fee as bigint)})`); break;
      case "Paid": it("Paid", `${usdc(a.amount as bigint)} to `, link(explorer, "address", a.to as string)); break;
      case "IntentProposed": it("Budget proposed", "for ", link(explorer, "address", a.counterparty as string), `, active from ${new Date(Number(a.activeAt) * 1000).toISOString().replace(".000Z", "Z")}`); break;
      case "IntentReduced": it("Budget reduced", `per payment ${usdc(a.maxPerTx as bigint)}, per period ${usdc(a.maxPerPeriod as bigint)}`); break;
      case "IntentRevoked": it("Budget revoked", `${short(a.id as string)}`); break;
      case "Paused": it(a.paused ? "Paused" : "Resumed", a.paused ? "agents can't spend" : "agents can spend again"); break;
      case "Withdrawn": it("Withdrawn", `${usdc(a.amount as bigint)} to `, link(explorer, "address", a.to as string)); break;
      case "BurnerSwept": it("Payer swept back", `${usdc(a.amount as bigint)} from `, link(explorer, "address", a.burner as string)); break;
      case "FeesFlushed": it("Fees paid out", `${usdc((a.toJar as bigint) + (a.toOps as bigint))}`); break;
      case "DelayChangeQueued": it("Timelock change queued", `${Number(a.delay) / 3600} h`); break;
      case "DelayChanged": it("Timelock changed", `${Number(a.delay) / 3600} h`); break;
      default: it(ev.eventName ?? "Event", "");
    }
  }
  for (const l of depositLogs) {
    const ev = decodeEventLog({ abi: erc20Abi, data: l.data, topics: l.topics as [Hex, ...Hex[]] });
    if (ev.eventName !== "Transfer") continue;
    items.push({ block: l.blockNumber!, index: l.logIndex!, tx: l.transactionHash!, what: "Deposit", detail: [`${usdc(ev.args.value)} from `, link(explorer, "address", ev.args.from)] });
  }
  items.sort((x, y) => (x.block === y.block ? y.index - x.index : x.block > y.block ? -1 : 1));
  const eventsEl = $("events");
  eventsEl.replaceChildren();
  if (!items.length) eventsEl.append(el("p", { class: "note" }, "No activity in the last 24 hours."));
  else {
    const list = el("ol", { class: "events" });
    for (const i of items) {
      const ago = Number((head.number - i.block) * BLOCK_SECONDS);
      const when = ago < 3600 ? `${Math.max(1, Math.round(ago / 60))} min ago` : `${Math.round(ago / 3600)} h ago`;
      list.append(el("li", {}, el("span", { class: "ev-what" }, i.what), el("span", { class: "ev-detail" }, ...i.detail), el("span", { class: "ev-when" }, `≈ ${when} · `, link(explorer, "tx", i.tx, "tx"))));
    }
    eventsEl.append(list);
  }

  out.hidden = false;
  status(`Read at block ${head.number}. Refresh to update.`);
}

let running = false;
async function run() {
  if (running) return;
  running = true;
  form.querySelector("button")!.disabled = true;
  try {
    await show(vaultInput.value, netSelect.value as NetKey);
  } catch (e) {
    status(friendly(e), "error");
  } finally {
    running = false;
    form.querySelector("button")!.disabled = false;
  }
}

form.addEventListener("submit", (e) => {
  e.preventDefault();
  void run();
});

const params = new URLSearchParams(location.search);
const pNet = params.get("network");
if (pNet === "base-sepolia" || pNet === "base") netSelect.value = pNet;
const pVault = params.get("vault");
if (pVault) {
  vaultInput.value = pVault;
  void run();
}
