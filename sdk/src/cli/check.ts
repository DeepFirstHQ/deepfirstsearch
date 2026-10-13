import { readFileSync } from "node:fs";
import { commitPlan } from "../guard/plan.js";
import { MerchantRegistry, type Merchant } from "../policy/registry.js";
import { dryRun } from "../x402/dryRun.js";
import type { Io } from "./owner.js";

const USAGE = `usage: agent-pay check <url> --registry <file.json> [--method POST] [--body '<json>'] [--header 'Name: value']... [--json]

Asks the owner's policy what it would do with a seller's answer, with no key: nothing is signed or paid.
The registry file is a JSON array of merchants, e.g.
  [{ "origin": "https://api.example.com", "payTo": "0x…", "network": "eip155:8453", "maxPerTx": "25000", "pricePin": "1000" }]
Amounts are atomic USDC units (6 decimals) as strings or integers.
Exit code: 0 allow / needsApproval / no_challenge, 1 deny / invalid_402, 2 usage or registry error.`;

type Parsed = { url: string; registryFile: string; method: string; body?: string; headers: [string, string][]; json: boolean };

function parse(args: string[]): Parsed | string {
  const out: Partial<Parsed> & { headers: [string, string][] } = { headers: [], method: "GET", json: false };
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
  const v = await dryRun(res, { url: p.url, policy, registry, plan });

  if (p.json) {
    io.out(JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x), 2));
  } else if (v.kind === "allow" || v.kind === "needsApproval") {
    const who = v.merchant.label ? `${v.merchant.label} (${v.requirement.payTo})` : v.requirement.payTo;
    io.out(`${v.kind}: would pay ${v.amount} atomic units (${v.requirement.scheme}, ${v.requirement.network}) to ${who}`);
    if (v.kind === "needsApproval") io.out(`  needs the owner's approval: ${v.reasons.join("; ")}`);
  } else if (v.kind === "deny") {
    io.out(`deny: ${v.codes.join(", ")}`);
    for (const r of v.reasons) io.out(`  ${r}`);
  } else {
    io.out(`${v.kind}: ${v.reason}`);
  }
  return v.kind === "deny" || v.kind === "invalid_402" ? 1 : 0;
}
