import { describe, expect, it } from "vitest";
import { MerchantRegistry } from "../../src/policy/registry.js";
import { commitPlan, SealedPlan } from "../../src/guard/plan.js";
import { taint } from "../../src/guard/taint.js";
import { PaymentDeniedError } from "../../src/guard/controls.js";
import { MERCHANT_PAYTO, ORIGIN, merchant } from "../fixtures.js";
import { fakeNet, mkPay } from "./helpers.js";

const reg = new MerchantRegistry([merchant()]);

describe("regression: registry origin matching", () => {
  const hits = [
    "https://api.pricing-intel.io/x",
    "https://API.PRICING-INTEL.IO/x",
    "https://api.pricing-intel.io:443/x",
    "https://user:pw@api.pricing-intel.io/x", // userinfo is not part of the origin; fetch rejects credentials anyway
  ];
  const misses = [
    "https://api.pricing-intel.io./x",
    "https://api.pricing-intel.io:8443/x",
    "https://api.pricing-intel.io.evil.com/x",
    "https://evil.com/api.pricing-intel.io",
    "https://evil.com#@api.pricing-intel.io",
    "https://evil.com\\@api.pricing-intel.io",
    "https://api.pricing-intel.io@evil.com/x",
    "https://аpi.pricing-intel.io/x", // Cyrillic a -> punycode, different origin
  ];
  for (const u of hits) it(`matches ${u}`, () => expect(reg.forUrl(u)?.payTo).toBe(MERCHANT_PAYTO));
  for (const u of misses) it(`does not match ${u}`, () => expect(reg.forUrl(u)).toBeUndefined());
  it("http is refused except for loopback", () => {
    expect(() => reg.forUrl("http://api.pricing-intel.io/x")).toThrow(/non-https/);
    expect(() => new MerchantRegistry([merchant({ origin: "http://localhost.evil.com" })])).toThrow();
    expect(() => new MerchantRegistry([merchant({ origin: "http://[::1]:8080" })])).toThrow();
  });
  it("resolve() only trusts an exact match, and never throws on garbage", () => {
    expect(reg.resolve(taint("https://api.pricing-intel.io.evil.com", "web"))).toBeUndefined();
    expect(reg.resolve(taint("javascript:alert(1)", "web"))).toBeUndefined();
    expect(reg.resolve(taint("not a url", "web"))).toBeUndefined();
  });
  it("merchants returned are frozen", () => {
    const m = reg.forUrl(ORIGIN)!;
    expect(() => {
      (m as { payTo: string }).payTo = "0x9999999999999999999999999999999999999999";
    }).toThrow();
  });
});

describe("regression: sealed plan", () => {
  it("cannot name a merchant outside the registry, nor non-positive budgets", () => {
    expect(() => commitPlan(reg, [{ origin: "https://evil.com", maxSpend: 1n }], 1000)).toThrow();
    expect(() => commitPlan(reg, [{ origin: ORIGIN, maxSpend: 0n }], 1000)).toThrow();
  });
  it("a plan for one origin does not cover a second registered origin", async () => {
    const net = fakeNet();
    const two = new MerchantRegistry([merchant(), merchant({ origin: "https://b.example" })]);
    const { pay } = mkPay(net, { registry: two });
    const plan = pay.commitPlan([{ origin: ORIGIN, maxSpend: 100_000n }], 60_000);
    await expect(pay.fetch("https://b.example/x", {}, { plan })).rejects.toThrow(/sealed plan/);
  });
});

describe("SDK-I-1 SealedPlan internals cannot be changed from outside", () => {
  it("limits and spend are private fields; there is no public limits map or record()", () => {
    const plan = commitPlan(reg, [{ origin: ORIGIN, maxSpend: 10_000n }], 60_000);
    const loose = plan as unknown as Record<string, unknown>;
    expect(loose.limits).toBeUndefined();
    expect(loose.spent).toBeUndefined();
    expect(loose.record).toBeUndefined();
    expect(Object.keys(plan).sort()).toEqual(["expiresAt", "hash", "id"]);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(() => {
      (plan as { expiresAt: number }).expiresAt = Number.MAX_SAFE_INTEGER;
    }).toThrow();
    expect(() => {
      loose.limits = new Map([[ORIGIN, 10n ** 18n]]);
    }).toThrow();
    expect(plan.remaining(ORIGIN)).toBe(10_000n);
  });

  it("reserve() rejects non-positive and over-budget amounts; release() rejects invalid amounts", () => {
    const plan = commitPlan(reg, [{ origin: ORIGIN, maxSpend: 10_000n }], 60_000);
    expect(plan.reserve(ORIGIN, 0n)).toBe(false);
    expect(plan.reserve(ORIGIN, -1_000_000n)).toBe(false);
    expect(plan.reserve(ORIGIN, 10_001n)).toBe(false);
    expect(plan.reserve("https://not-in-plan.example", 1n)).toBe(false);
    expect(plan.remaining(ORIGIN)).toBe(10_000n);
    expect(plan.reserve(ORIGIN, 6_000n)).toBe(true);
    expect(plan.reserve(ORIGIN, 6_000n)).toBe(false);
    expect(() => plan.release(ORIGIN, 0n)).toThrow(/invalid plan release/);
    expect(() => plan.release(ORIGIN, -1_000_000n)).toThrow(/invalid plan release/);
    expect(() => plan.release(ORIGIN, 6_001n)).toThrow(/invalid plan release/);
    expect(plan.remaining(ORIGIN)).toBe(4_000n);
    plan.release(ORIGIN, 6_000n);
    expect(plan.remaining(ORIGIN)).toBe(10_000n);
  });

  it("residual: a SealedPlan can still be constructed directly, bypassing the registry check and the audit entry", () => {
    expect(new SealedPlan([{ origin: "https://not-registered.example", maxSpend: 1n }], Date.now() + 1000).covers("https://not-registered.example", Date.now())).toBe(true);
  });
});

describe("SDK-I-2 audit coverage of blocked payments", () => {
  it("an http:// URL that answers 402 is denied with a typed error and audited", async () => {
    const net = fakeNet();
    const { pay, plan } = mkPay(net);
    const before = pay.audit.entries.length;
    const err = await pay.fetch("http://evil.example/pay", {}, { plan }).catch((e) => e);
    expect(err).toBeInstanceOf(PaymentDeniedError);
    expect(String(err)).toMatch(/non-https/);
    expect(pay.audit.entries.length).toBe(before + 1);
    expect(net.signed).toHaveLength(0);
  });
  it("a rate-limit block is audited as payment.denied", async () => {
    const net = fakeNet();
    const { pay, plan } = mkPay(net, { rateLimit: { max: 1, windowMs: 60_000 } });
    await pay.fetch(`${ORIGIN}/a`, {}, { plan });
    const n = pay.audit.entries.length;
    await expect(pay.fetch(`${ORIGIN}/b`, {}, { plan })).rejects.toThrow(/rate limit/);
    expect(pay.audit.entries.length).toBe(n + 1);
    const last = pay.audit.entries.at(-1)!.event as { type: string; reasons?: string[] };
    expect(last.type).toBe("payment.denied");
    expect(last.reasons?.join()).toMatch(/rate limit/);
    expect(net.signed).toHaveLength(1);
  });
});
