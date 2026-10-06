import { describe, expect, it } from "vitest";
import { PaymentBlockedError, PaymentDeniedError } from "../../src/guard/controls.js";
import { ORIGIN } from "../fixtures.js";
import { fakeNet, mkPay } from "./helpers.js";

const denials = (pay: { audit: { entries: { event: { type: string } }[] } }) =>
  pay.audit.entries.filter((e) => e.event.type === "payment.denied").length;

// SDK-H-1: plan, period and rate-limit budgets are reserved synchronously before any await, so concurrent
// pay.fetch calls cannot all pass the same check.
describe("SDK-H-1 concurrent payments cannot exceed the sealed plan, period budget or rate limit", () => {
  it("parallel requests never sign past the sealed plan's maxSpend", async () => {
    const net = fakeNet();
    // Plan allows 30_000 = three payments of 10_000. Slow ensureFunded (vaultFunder waits 2 confirmations).
    const { pay, plan } = mkPay(net, {
      planMax: 30_000n,
      ensureFunded: () => new Promise((r) => setTimeout(r, 50)),
    });
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => pay.fetch(`${ORIGIN}/data`, {}, { plan })));
    const signedTotal = net.signed.reduce((s, p) => s + BigInt(p.payload.authorization.value), 0n);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(rejected).toHaveLength(7);
    for (const r of rejected) expect(r.reason).toBeInstanceOf(PaymentDeniedError);
    expect(net.signed).toHaveLength(3);
    expect(signedTotal).toBe(30_000n);
    expect(plan.remaining(ORIGIN)).toBe(0n);
    expect(denials(pay)).toBe(7);
  });

  it("parallel requests never sign past the period budget", async () => {
    const net = fakeNet();
    const { pay, plan } = mkPay(net, {
      planMax: 1_000_000n,
      policy: { allowedNetworks: ["eip155:84532"], periodBudget: { amount: 20_000n, periodMs: 86_400_000 } },
      ensureFunded: () => new Promise((r) => setTimeout(r, 20)),
    });
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => pay.fetch(`${ORIGIN}/data`, {}, { plan })));
    expect(net.signed).toHaveLength(2);
    for (const r of results.filter((r): r is PromiseRejectedResult => r.status === "rejected")) {
      expect(r.reason).toBeInstanceOf(PaymentDeniedError);
    }
    expect(denials(pay)).toBe(4);
  });

  it("parallel requests never sign past the per-origin rate limit", async () => {
    const net = fakeNet();
    const { pay, plan } = mkPay(net, {
      planMax: 1_000_000n,
      rateLimit: { max: 1, windowMs: 60_000 },
      ensureFunded: () => new Promise((r) => setTimeout(r, 20)),
    });
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => pay.fetch(`${ORIGIN}/data`, {}, { plan })));
    expect(net.signed).toHaveLength(1);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(rejected).toHaveLength(5);
    for (const r of rejected) expect(r.reason).toBeInstanceOf(PaymentBlockedError);
    expect(denials(pay)).toBe(5);
  });

  it("without a slow funder, the async payer/signing awaits cannot race either", async () => {
    const net = fakeNet();
    const { pay, plan } = mkPay(net, { planMax: 10_000n });
    await Promise.allSettled(Array.from({ length: 5 }, () => pay.fetch(`${ORIGIN}/data`, {}, { plan })));
    expect(net.signed).toHaveLength(1);
    expect(plan.remaining(ORIGIN)).toBe(0n);
  });

  it("a payment awaiting approval holds its reservation, so others are denied", { timeout: 5_000 }, async () => {
    const net = fakeNet();
    const approvals: ((v: boolean) => void)[] = [];
    const { pay, plan } = mkPay(net, {
      planMax: 10_000n, // one payment
      session: { readsUntrustedInput: true, accessesSensitiveData: true, canPay: true }, // human for every payment
      approve: () => new Promise<boolean>((r) => approvals.push(r)),
    });
    const first = pay.fetch(`${ORIGIN}/a`, {}, { plan });
    for (let i = 0; approvals.length < 1 && i < 200; i++) await new Promise((r) => setTimeout(r, 1));
    expect(approvals).toHaveLength(1);
    expect(plan.remaining(ORIGIN)).toBe(0n); // reserved while the human decides
    await expect(pay.fetch(`${ORIGIN}/b`, {}, { plan })).rejects.toBeInstanceOf(PaymentDeniedError);
    await expect(pay.fetch(`${ORIGIN}/c`, {}, { plan })).rejects.toBeInstanceOf(PaymentDeniedError);
    expect(approvals).toHaveLength(1); // the human is never asked about the excess payments
    approvals[0]!(true);
    expect((await first).status).toBe(200);
    expect(net.signed).toHaveLength(1);
    expect(plan.remaining(ORIGIN)).toBe(0n);
  });

  it("a refused approval releases its reservation", { timeout: 5_000 }, async () => {
    const net = fakeNet();
    const approvals: ((v: boolean) => void)[] = [];
    const { pay, plan } = mkPay(net, {
      planMax: 10_000n,
      session: { readsUntrustedInput: true, accessesSensitiveData: true, canPay: true },
      approve: () => new Promise<boolean>((r) => approvals.push(r)),
    });
    const first = pay.fetch(`${ORIGIN}/a`, {}, { plan });
    for (let i = 0; approvals.length < 1 && i < 200; i++) await new Promise((r) => setTimeout(r, 1));
    expect(plan.remaining(ORIGIN)).toBe(0n);
    approvals[0]!(false);
    await expect(first).rejects.toThrow(/human approval refused/);
    expect(plan.remaining(ORIGIN)).toBe(10_000n);
    expect(net.signed).toHaveLength(0);
  });
});
