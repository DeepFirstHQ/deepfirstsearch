import { readFileSync } from "node:fs";
import { getAddress, isAddress } from "viem";
import { commitPlan } from "../guard/plan.js";
import { pinnedAsset } from "../policy/networks.js";
import { MerchantRegistry, type Merchant } from "../policy/registry.js";
import { dryRun, readChallenge, type DryRunVerdict } from "../x402/dryRun.js";
import type { PaymentRequirements } from "../x402/schemas.js";
import { readBodyCapped } from "../x402/v1.js";
import type { Io } from "./owner.js";

const USAGE = `usage: agent-pay check <url> --registry <file.json> [--method POST] [--body '<json>'] [--header 'Name: value']... [--manifest] [--json]

Asks the owner's policy what it would do with a seller's answer, with no key: nothing is signed or paid.
The registry file is a JSON array of merchants, e.g.
  [{ "origin": "https://api.example.com", "payTo": "0x…", "network": "eip155:8453", "maxPerTx": "25000", "pricePin": "1000" }]
Amounts are atomic USDC units (6 decimals) as strings or integers.
When the seller's address or price no longer matches the registry, it prints the edit that would accept the change.
It never applies it: the 402 alone can't tell a rotation from a hijack, so confirm with the seller first.
--manifest also reads <origin>/.well-known/x402 and says whether it agrees with the 402.
Exit code: 0 allow / needsApproval / no_challenge, 1 deny / invalid_402, 2 usage or registry error.`;

type Parsed = { url: string; registryFile: string; method: string; body?: string; headers: [string, string][]; json: boolean; manifest: boolean };

function parse(args: string[]): Parsed | string {
  const out: Partial<Parsed> & { headers: [string, string][] } = { headers: [], method: "GET", json: false, manifest: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const next = () => {
      const v = args[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === "--registry") out.registryFile = next();
    else if (a === "--method") out.method = next().toUpperCase();
    else if (a === "--body") out.body = next();
    else if (a === "--header") {
      const h = next();
      const idx = h.indexOf(":");
      if (idx <= 0) return `bad --header "${h}" (expected "Name: value")`;
      out.headers.push([h.slice(0, idx).trim(), h.slice(idx + 1).trim()]);
    } else if (a === "--json") out.json = true;
    else if (a === "--manifest") out.manifest = true;
    else if (a === "help" || a === "--help" || a === "-h") return USAGE;
    else if (a.startsWith("--")) return `unknown option ${a}`;
    else if (out.url === undefined) out.url = a;
    else return `unexpected argument ${a}`;
  }
  if (!out.url) return USAGE;
  if (!out.registryFile) return "--registry <file.json> is required";
  return out as Parsed;
}

const atomic = (v: unknown, field: string): bigint => {
  if ((typeof v === "string" && /^\d+$/.test(v)) || (typeof v === "number" && Number.isSafeInteger(v) && v >= 0)) return BigInt(v);
  throw new Error(`${field} must be a non-negative integer (atomic units)`);
};

/** Reads the owner's registry file. Amounts are atomic units; the same validation as the SDK applies. */
export function loadRegistryFile(text: string): Merchant[] {
  const raw = JSON.parse(text) as unknown;
  if (!Array.isArray(raw) || raw.length === 0) throw new Error("the registry file must be a non-empty JSON array of merchants");
  return raw.map((m, i) => {
    if (!m || typeof m !== "object") throw new Error(`merchant ${i} is not an object`);
    const r = m as Record<string, unknown>;
    for (const k of ["origin", "payTo", "network"]) if (typeof r[k] !== "string") throw new Error(`merchant ${i}: ${k} is required`);
    return {
      origin: r.origin as string,
      payTo: r.payTo as `0x${string}`,
      network: r.network as string,
      maxPerTx: atomic(r.maxPerTx, `merchant ${i}: maxPerTx`),
      ...(r.pricePin !== undefined ? { pricePin: atomic(r.pricePin, `merchant ${i}: pricePin`) } : {}),
      ...(r.toleranceBps !== undefined ? { toleranceBps: Number(r.toleranceBps) } : {}),
      ...(r.label !== undefined ? { label: String(r.label) } : {}),
      ...(r.x402Versions !== undefined ? { x402Versions: r.x402Versions as (1 | 2)[] } : {}),
    };
  });
}

/** `agent-pay check`: one request, one verdict. Never sends a payment header. */
export async function check(args: string[], io: Io, fetchImpl: typeof fetch = globalThis.fetch): Promise<number> {
  let p: Parsed | string;
  try {
    p = parse(args);
  } catch (e) {
    p = (e as Error).message;
  }
  if (typeof p === "string") {
    (p === USAGE ? io.out : io.err)(p);
    return p === USAGE ? 0 : 2;
  }
  let merchants: Merchant[];
  let registry: MerchantRegistry;
  try {
    merchants = loadRegistryFile(readFileSync(p.registryFile, "utf8"));
    registry = new MerchantRegistry(merchants);
  } catch (e) {
    io.err(`registry: ${(e as Error).message}`);
    return 2;
  }
  const plan = commitPlan(registry, merchants.map((m) => ({ origin: m.origin, maxSpend: m.maxPerTx })), 3_600_000);
  const policy = { allowedNetworks: [...new Set(merchants.map((m) => m.network))] };

  const res = await fetchImpl(p.url, { method: p.method, headers: Object.fromEntries(p.headers), ...(p.body !== undefined ? { body: p.body } : {}) });
  const copy = res.clone();
  const v = await dryRun(res, { url: p.url, policy, registry, plan });
  const merchant = registry.forUrl(p.url);
  const index = merchant ? merchants.findIndex((m) => new URL(m.origin).origin === merchant.origin) : -1;
  const offer = merchant ? await offerFor(copy, merchant) : undefined;
  const proposal = merchant && offer && v.kind === "deny" ? proposeEdit(merchant, offer) : undefined;
  const manifest = p.manifest ? await readManifest(p.url, merchant, offer, fetchImpl) : undefined;

  if (p.json) {
    const out = { ...v, ...(proposal ? { proposal: { merchant: index, origin: merchant!.origin, edits: proposal } } : {}), ...(manifest ? { manifest } : {}) };
    io.out(JSON.stringify(out, (_k, x) => (typeof x === "bigint" ? x.toString() : x), 2));
    return exitCode(v);
  }
  if (v.kind === "allow" || v.kind === "needsApproval") {
    const who = v.merchant.label ? `${v.merchant.label} (${v.requirement.payTo})` : v.requirement.payTo;
    io.out(`${v.kind}: would pay ${v.amount} atomic units (${v.requirement.scheme}, ${v.requirement.network}) to ${who}`);
    if (v.kind === "needsApproval") io.out(`  needs the owner's approval: ${v.reasons.join("; ")}`);
  } else if (v.kind === "deny") {
    io.out(`deny: ${v.codes.join(", ")}`);
    for (const r of v.reasons) io.out(`  ${r}`);
  } else {
    io.out(`${v.kind}: ${v.reason}`);
  }
  if (proposal?.length) {
    io.out(`if the seller really changed its terms, the edit to merchant ${index} (${merchant!.origin}) in ${p.registryFile} would be:`);
    for (const e of proposal) io.out(`  ${e.field}: ${e.from ?? "(none)"} -> ${e.to}`);
    io.out("  the 402 alone can't tell a rotation from a hijack: confirm it through a channel this server doesn't control before editing.");
  }
  if (manifest) {
    if ("error" in manifest) io.out(`manifest ${manifest.url}: ${manifest.error}`);
    else {
      io.out(`manifest ${manifest.url}: payTo ${manifest.payTo ?? "(not listed)"}, price ${manifest.amount ?? "(not listed)"} atomic units`);
      if (manifest.differsFrom402.length) io.out(`  differs from the 402 on ${manifest.differsFrom402.join(", ")}: don't edit the registry from either; ask the seller.`);
      else if (offer) io.out(`  agrees with the 402${proposal?.length ? " (same server as the 402: that shows consistency, not that the change is genuine)" : ""}.`);
    }
  }
  return exitCode(v);
}

const exitCode = (v: DryRunVerdict) => (v.kind === "deny" || v.kind === "invalid_402" ? 1 : 0);

/** The 402 option that the merchant's own pins would compare against: exact scheme, its network, the pinned USDC; the cheapest. */
async function offerFor(res: Response, merchant: Merchant): Promise<{ payTo: `0x${string}`; amount: bigint } | undefined> {
  const c = await readChallenge(res);
  if (c.kind !== "terms") return undefined;
  const asset = pinnedAsset(merchant.network);
  const fits = c.required.accepts.filter(
    (r: PaymentRequirements) => r.scheme === "exact" && r.network === merchant.network && !!asset && r.asset.toLowerCase() === asset.asset.toLowerCase() && isAddress(r.payTo),
  );
  if (fits.length === 0) return undefined;
  const best = fits.reduce((a, b) => (BigInt(b.amount) < BigInt(a.amount) ? b : a));
  return { payTo: getAddress(best.payTo), amount: BigInt(best.amount) };
}

type Edit = { field: "payTo" | "pricePin" | "maxPerTx"; from?: string; to: string };

/** What would have to change in the registry for this 402 to pass. Shown to the owner, never applied. */
export function proposeEdit(m: Merchant, offer: { payTo: `0x${string}`; amount: bigint }): Edit[] {
  const edits: Edit[] = [];
  if (offer.payTo !== getAddress(m.payTo)) edits.push({ field: "payTo", from: m.payTo, to: offer.payTo });
  if (m.pricePin !== undefined) {
    const ceiling = m.pricePin + (m.pricePin * BigInt(m.toleranceBps ?? 0)) / 10_000n;
    if (offer.amount > ceiling) edits.push({ field: "pricePin", from: String(m.pricePin), to: String(offer.amount) });
  }
  if (offer.amount > m.maxPerTx) edits.push({ field: "maxPerTx", from: String(m.maxPerTx), to: String(offer.amount) });
  return edits;
}

const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;

type ManifestReport = { url: string; error: string } | { url: string; payTo?: string; amount?: bigint; differsFrom402: string[] };

/** Reads the seller's /.well-known/x402 on the same origin and finds the terms it lists for this path. Data, never applied. */
async function readManifest(
  url: string,
  merchant: Merchant | undefined,
  offer: { payTo: `0x${string}`; amount: bigint } | undefined,
  fetchImpl: typeof fetch,
): Promise<ManifestReport> {
  const target = new URL(url);
  const murl = `${target.origin}/.well-known/x402`;
  let json: unknown;
  try {
    const r = await fetchImpl(murl, { redirect: "manual" });
    if (r.status !== 200) return { url: murl, error: `HTTP ${r.status} (redirects are not followed)` };
    const text = await readBodyCapped(r, MAX_MANIFEST_BYTES);
    if (text === undefined) return { url: murl, error: "larger than 2 MB" };
    try {
      json = JSON.parse(text);
    } catch {
      return { url: murl, error: "not JSON" };
    }
  } catch {
    // The server's own text never reaches the output.
    return { url: murl, error: "unreachable" };
  }
  const t = manifestTerms(json, target, merchant?.network);
  if (!t) return { url: murl, error: `no entry for ${target.pathname}` };
  const differsFrom402: string[] = [];
  if (offer && t.payTo && t.payTo !== offer.payTo) differsFrom402.push("payTo");
  if (offer && t.amount !== undefined && t.amount !== offer.amount) differsFrom402.push("price");
  return { url: murl, ...t, differsFrom402 };
}

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);

/** "$0.003", "0.003" -> 3000 (6 decimals); a plain integer string is already atomic. */
export function usdcAtomic(price: unknown, atomic = false): bigint | undefined {
  if (typeof price !== "string" && typeof price !== "number") return undefined;
  const s = String(price).trim();
  if (atomic) return /^\d+$/.test(s) ? BigInt(s) : undefined;
  const m = /^\$?(\d{1,12})(?:\.(\d{1,6}))?$/.exec(s);
  return m ? BigInt(m[1]!) * 1_000_000n + BigInt((m[2] ?? "").padEnd(6, "0")) : undefined;
}

const addr = (x: unknown) => (typeof x === "string" && isAddress(x) ? getAddress(x) : undefined);

/** The terms a manifest lists for one URL: an entry in endpoints/resources/items matched by path, its payTo or the top-level one. */
export function manifestTerms(json: unknown, target: URL, network?: string): { payTo?: `0x${string}`; amount?: bigint } | undefined {
  if (!isObj(json)) return undefined;
  const list = [json.endpoints, json.resources, json.items].find(Array.isArray) as unknown[] | undefined;
  const entry = list?.find((e) => {
    if (!isObj(e)) return false;
    const where = e.url ?? e.resource ?? e.path;
    if (typeof where !== "string") return false;
    try {
      const u = new URL(where, target.origin);
      return u.origin === target.origin && u.pathname === target.pathname;
    } catch {
      return false;
    }
  }) as Record<string, unknown> | undefined;
  if (!entry) return undefined;
  const accepts = Array.isArray(entry.accepts) ? entry.accepts.filter(isObj).find((a) => !network || a.network === network) : undefined;
  const payment = isObj(json.payment) ? json.payment : undefined;
  const payTo = addr(entry.payTo) ?? addr(accepts?.payTo) ?? addr(payment?.payTo) ?? addr(json.payTo);
  const amount = usdcAtomic(entry.price) ?? usdcAtomic(entry.amount, true) ?? usdcAtomic(accepts?.amount, true) ?? usdcAtomic(accepts?.maxAmountRequired, true);
  return { ...(payTo ? { payTo } : {}), ...(amount !== undefined ? { amount } : {}) };
}
