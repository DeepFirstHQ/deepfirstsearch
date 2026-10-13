import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { check } from "../src/cli/check.js";
import { startMockServer, type MockServer } from "../src/testing/index.js";

const MERCHANT = "0x1111111111111111111111111111111111111111";
const ATTACKER = "0x9999999999999999999999999999999999999999";
let m: MockServer;
let registryFile: string;
const io = () => {
  const out: string[] = [], err: string[] = [];
  return { io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) }, out, err };
};

beforeAll(async () => {
  m = await startMockServer({
    "/ok": { price: 1_000n, payTo: MERCHANT },
    "/evil": { price: 1_000n, payTo: MERCHANT, tamper: (r) => ({ ...r, payTo: ATTACKER }) },
    "/pricey": { price: 900_000n, payTo: MERCHANT },
  });
  registryFile = join(mkdtempSync(join(tmpdir(), "check-")), "registry.json");
  writeFileSync(registryFile, JSON.stringify([{ origin: m.url, payTo: MERCHANT, network: "eip155:84532", maxPerTx: "5000", pricePin: 1000, label: "test API" }]));
});
afterAll(async () => { await m.close(); });

describe("agent-pay check", () => {
  it("allow: prints what it would pay and to whom, exit 0", async () => {
    const t = io();
    expect(await check([`${m.url}/ok`, "--registry", registryFile], t.io)).toBe(0);
    expect(t.out.join("\n")).toMatch(/^allow: would pay 1000 atomic units \(exact, eip155:84532\) to test API \(0x1111/);
  });

  it("deny with codes and reasons, exit 1", async () => {
    for (const [path, code] of [["/evil", "payee_mismatch"], ["/pricey", "over_cap"]] as const) {
      const t = io();
      expect(await check([`${m.url}${path}`, "--registry", registryFile], t.io)).toBe(1);
      expect(t.out[0]).toContain(code);
    }
  });

  it("an origin outside the registry is unknown_merchant", async () => {
    const other = await startMockServer({ "/x": { price: 1_000n, payTo: MERCHANT } });
    try {
      const t = io();
      expect(await check([`${other.url}/x`, "--registry", registryFile], t.io)).toBe(1);
      expect(t.out[0]).toBe("deny: unknown_merchant");
    } finally { await other.close(); }
  });

  it("no_challenge when the seller shows no terms, exit 0", async () => {
    const t = io();
    const fakeFetch = (async () => new Response("free", { status: 200 })) as unknown as typeof fetch;
    expect(await check([`${m.url}/free`, "--registry", registryFile], t.io, fakeFetch)).toBe(0);
    expect(t.out[0]).toBe("no_challenge: HTTP 200: no payment terms shown to this caller");
  });

  it("never sends a payment header", async () => {
    const seen: Headers[] = [];
    const spy = (async (u: string, init: RequestInit) => { seen.push(new Headers(init.headers)); return fetch(u, init); }) as unknown as typeof fetch;
    await check([`${m.url}/ok`, "--registry", registryFile, "--header", "X-Test: 1"], io().io, spy);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.get("PAYMENT-SIGNATURE")).toBeNull();
    expect(seen[0]!.get("X-PAYMENT")).toBeNull();
    expect(seen[0]!.get("X-Test")).toBe("1");
  });

  it("--json prints the verdict as JSON", async () => {
    const t = io();
    await check([`${m.url}/ok`, "--registry", registryFile, "--json"], t.io);
    expect(JSON.parse(t.out.join("\n"))).toMatchObject({ kind: "allow", amount: "1000", status: 402 });
  });

  it("usage and registry errors exit 2 without fetching", async () => {
    let fetched = 0;
    const f = (async () => { fetched++; return new Response(null, { status: 200 }); }) as unknown as typeof fetch;
    const bad = join(mkdtempSync(join(tmpdir(), "check-")), "bad.json");
    writeFileSync(bad, JSON.stringify([{ origin: m.url, payTo: MERCHANT, network: "eip155:84532", maxPerTx: "1.5" }]));
    for (const args of [[`${m.url}/ok`], [`${m.url}/ok`, "--registry", bad], [`${m.url}/ok`, "--registry"], [`${m.url}/ok`, "--registry", registryFile, "--header", "nocolon"]]) {
      const t = io();
      expect(await check(args, t.io, f)).toBe(2);
    }
    expect(fetched).toBe(0);
  });
});
