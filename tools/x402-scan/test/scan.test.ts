import { describe, expect, it } from "vitest";
import { scan, lintRequired, DEFAULTS, type PayingFetch } from "../src/index.js";

const SELLER = DEFAULTS.payTo;
const CAP = 50_000n; // the owner's per-call cap, in atomic units
const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
const required = (headerValue: string) => JSON.parse(Buffer.from(headerValue, "base64").toString("utf8"));

/** Builds a payment payload the way a buyer client does (the scanner reads it; no real signature is needed). */
function sign(a: { network: string; payTo: string; amount: string; maxTimeoutSeconds?: number }) {
  const now = Math.floor(Date.now() / 1000);
  return b64(JSON.stringify({
    x402Version: 2, network: a.network,
    payload: { signature: "0xfake", authorization: { from: "0x0000000000000000000000000000000000000001", to: a.payTo, value: a.amount, validAfter: "0", validBefore: String(now + (a.maxTimeoutSeconds ?? 120)), nonce: `0x${"00".repeat(32)}` } },
  }));
}

/** A naive client: pays whatever the 402 names, however much, on any network. Falls for every attack. */
const naive: PayingFetch = async (url) => {
  const res = await fetch(url);
  if (res.status !== 402) return;
  const a = required(res.headers.get("PAYMENT-REQUIRED")!).accepts[0];
  await fetch(url, { method: "POST", headers: { "payment-signature": sign(a) } });
};

/** A safe client: pins the payee, caps the amount in atomic units, allows one network, and bounds the validity. */
const safe: PayingFetch = async (url) => {
  const res = await fetch(url);
  if (res.status !== 402) return;
  const a = required(res.headers.get("PAYMENT-REQUIRED")!).accepts[0];
  if (a.payTo.toLowerCase() !== SELLER.toLowerCase()) throw new Error("payee_mismatch");
  if (a.network !== DEFAULTS.network || a.asset.toLowerCase() !== DEFAULTS.asset.toLowerCase()) throw new Error("network_not_allowed");
  if (BigInt(a.amount) > CAP) throw new Error("over_cap"); // atomic units; the declared decimals change nothing
  await fetch(url, { method: "POST", headers: { "payment-signature": sign({ ...a, maxTimeoutSeconds: 120 }) } });
};

describe("scan", () => {
  it("catches a naive client: control passes, every safety check fails (grade F)", async () => {
    const r = await scan(() => naive, { port: 0 });
    expect(r.results.find((x) => x.id === "baseline")?.pass).toBe(true);
    const failed = r.results.filter((x) => !x.control && !x.pass).map((x) => x.id);
    expect(failed).toEqual(["swapped-payee", "inflated-decimals", "price-bump", "long-timeout", "foreign-network"]);
    expect(r.grade).toBe("F");
    expect(r.safe).toBe(false);
  });

  it("passes a safe client: control passes and no safety check fails (grade A)", async () => {
    const r = await scan(() => safe, { port: 0 });
    expect(r.results.filter((x) => !x.control && !x.pass)).toHaveLength(0);
    expect(r.grade).toBe("A");
    expect(r.safe).toBe(true);
  });

  it("reports n/a when the control fails (client not wired to pay)", async () => {
    const r = await scan(() => async () => undefined, { port: 0 });
    expect(r.grade).toBe("n/a");
    expect(r.results.find((x) => x.id === "baseline")?.pass).toBe(false);
  });
});

describe("lint", () => {
  it("flags a Permit request as dangerous", () => {
    const f = lintRequired({ x402Version: 2, accepts: [{ scheme: "exact", network: "eip155:8453", asset: DEFAULTS.asset, payTo: SELLER, amount: "1000", extra: { primaryType: "Permit" } }] });
    expect(f.some((x) => x.code === "permit" && x.level === "danger")).toBe(true);
  });

  it("flags declared decimals that disagree with known USDC", () => {
    const f = lintRequired({ x402Version: 2, accepts: [{ scheme: "exact", network: "eip155:8453", asset: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", payTo: SELLER, amount: "1000000000", extra: { name: "USDC", version: "2", decimals: 18 } }] });
    expect(f.some((x) => x.code === "declared_decimals" && x.level === "danger")).toBe(true);
  });

  it("flags a multi-network 402", () => {
    const f = lintRequired({ x402Version: 2, accepts: [
      { scheme: "exact", network: "eip155:8453", asset: DEFAULTS.asset, payTo: SELLER, amount: "1000", extra: { name: "USDC", version: "2" } },
      { scheme: "exact", network: "eip155:1", asset: DEFAULTS.asset, payTo: SELLER, amount: "1000", extra: { name: "USDC", version: "2" } },
    ] });
    expect(f.some((x) => x.code === "multi_network")).toBe(true);
  });
});

// The `--json` CLI flag prints the raw report. Guard that the reports are JSON-serializable (no bigints leak)
// and round-trip without loss, so the machine-readable schema stays stable for CI and the GitHub Action.
describe("--json output contract", () => {
  it("a scan report round-trips through JSON without loss", async () => {
    const r = await scan(() => naive, { port: 0 });
    const round = JSON.parse(JSON.stringify(r));
    expect(round).toEqual(r);
    expect(round.grade).toBe("F");
    expect(round.results[0]).toHaveProperty("id");
    expect(round.results[0]).toHaveProperty("pass");
  });

  it("lint findings are JSON-serializable with a stable shape", () => {
    const f = lintRequired({ x402Version: 2, accepts: [{ scheme: "exact", network: "eip155:8453", asset: DEFAULTS.asset, payTo: SELLER, amount: "1000", extra: { primaryType: "Permit" } }] });
    const round = JSON.parse(JSON.stringify(f));
    expect(round).toEqual(f);
    expect(round[0]).toHaveProperty("code");
    expect(round[0]).toHaveProperty("level");
    expect(round[0]).toHaveProperty("message");
  });
});
