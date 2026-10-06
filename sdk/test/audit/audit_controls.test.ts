import { describe, expect, it } from "vitest";
import { PaymentBlockedError, PaymentDeniedError } from "../../src/guard/controls.js";
import { ORIGIN } from "../fixtures.js";
import { fakeNet, mkPay } from "./helpers.js";

describe("SDK-L-1 kill switch and plan expiry are re-checked after slow awaits", () => {
  it("kill switch pulled while ensureFunded waits for confirmations stops the signature", async () => {
    const net = fakeNet();
    let killNow!: () => void;
    const { pay, plan } = mkPay(net, {
      ensureFunded: async () => {
        killNow(); // operator hits the kill switch during the ~4s fundBurner confirmation wait
      },
    });
    killNow = () => pay.kill("incident");
    await expect(pay.fetch(`${ORIGIN}/data`, {}, { plan })).rejects.toBeInstanceOf(PaymentBlockedError);
    expect(net.signed).toHaveLength(0);
    expect(plan.remaining(ORIGIN)).toBe(30_000n);
    await expect(pay.fetch(`${ORIGIN}/data`, {}, { plan })).rejects.toBeInstanceOf(PaymentBlockedError);
  });

  it("a plan that expires while a human is approving is not used to sign", async () => {
    const net = fakeNet();
    let t = 1_000_000;
    const { pay } = mkPay(net, {
      now: () => t,
      session: { readsUntrustedInput: true, accessesSensitiveData: true, canPay: true },
      approve: async () => {
        t += 2 * 3_600_000; // approval took longer than the plan TTL
        return true;
      },
    });
    const plan = pay.commitPlan([{ origin: ORIGIN, maxSpend: 30_000n }], 60_000);
    const err = await pay.fetch(`${ORIGIN}/data`, {}, { plan }).catch((e) => e);
    expect(err).toBeInstanceOf(PaymentDeniedError);
    expect(err.message).toMatch(/sealed plan expired before signing/);
    expect(plan.covers(ORIGIN, t)).toBe(false);
    expect(net.signed).toHaveLength(0);
  });
});

describe("SDK-I-5 period budget is a fixed window", () => {
  it("allows 2x the period budget across a window boundary", async () => {
    const net = fakeNet();
    let t = 0;
    const { pay } = mkPay(net, {
      now: () => t,
      policy: { allowedNetworks: ["eip155:84532"], periodBudget: { amount: 20_000n, periodMs: 86_400_000 } },
    });
    t = 86_400_000 - 1000;
    const plan = pay.commitPlan([{ origin: ORIGIN, maxSpend: 1_000_000n }], 3_600_000);
    await pay.fetch(`${ORIGIN}/a`, {}, { plan });
    await pay.fetch(`${ORIGIN}/b`, {}, { plan });
    await expect(pay.fetch(`${ORIGIN}/c`, {}, { plan })).rejects.toBeInstanceOf(PaymentDeniedError);
    t = 86_400_000 + 1000; // 2 seconds later
    await pay.fetch(`${ORIGIN}/d`, {}, { plan });
    await pay.fetch(`${ORIGIN}/e`, {}, { plan });
    expect(net.signed).toHaveLength(4); // 40_000 in ~2s against a 20_000/day budget
  });
});

describe("regression: sequential controls hold", () => {
  it("sequential payments stop exactly at the plan budget", async () => {
    const net = fakeNet();
    const { pay, plan } = mkPay(net, { planMax: 20_000n });
    await pay.fetch(`${ORIGIN}/a`, {}, { plan });
    await pay.fetch(`${ORIGIN}/b`, {}, { plan });
    await expect(pay.fetch(`${ORIGIN}/c`, {}, { plan })).rejects.toThrow(/sealed plan/);
    expect(net.signed).toHaveLength(2);
  });

  it("sequential rate limit holds", async () => {
    const net = fakeNet();
    const { pay, plan } = mkPay(net, { planMax: 100_000n, rateLimit: { max: 2, windowMs: 60_000 } });
    await pay.fetch(`${ORIGIN}/a`, {}, { plan });
    await pay.fetch(`${ORIGIN}/b`, {}, { plan });
    await expect(pay.fetch(`${ORIGIN}/c`, {}, { plan })).rejects.toThrow(/rate limit/);
  });

  it("kill switch before the request blocks without contacting the server", async () => {
    const net = fakeNet();
    const { pay, plan } = mkPay(net);
    pay.kill();
    await expect(pay.fetch(`${ORIGIN}/a`, {}, { plan })).rejects.toBeInstanceOf(PaymentBlockedError);
    expect(net.sent).toHaveLength(0);
  });

  it("kill switch pulled during approval blocks the signature", async () => {
    const net = fakeNet();
    let k!: () => void;
    const { pay, plan } = mkPay(net, {
      session: { readsUntrustedInput: true, accessesSensitiveData: true, canPay: true },
      approve: async () => (k(), true),
    });
    k = () => pay.kill();
    await expect(pay.fetch(`${ORIGIN}/a`, {}, { plan })).rejects.toBeInstanceOf(PaymentBlockedError);
    expect(net.signed).toHaveLength(0);
  });

  it("sanctions screen that throws fails closed", async () => {
    const net = fakeNet();
    const { pay, plan } = mkPay(net, { screen: async () => { throw new Error("oracle down"); } });
    await expect(pay.fetch(`${ORIGIN}/a`, {}, { plan })).rejects.toThrow(/oracle down/);
    expect(net.signed).toHaveLength(0);
  });

  it("oracleScreen fails closed when the RPC errors", async () => {
    const { oracleScreen } = await import("../../src/policy/sanctions.js");
    const screen = oracleScreen({ readContract: async () => { throw new Error("rpc"); } } as never, "0x0000000000000000000000000000000000000001");
    expect(await screen("0x1111111111111111111111111111111111111111")).toBe(true);
  });

  it("approval threshold routes large payments to a human, and default denyAll refuses", async () => {
    const { req402, resp } = await import("./helpers.js");
    const { requirement } = await import("../fixtures.js");
    const net = fakeNet({ onFirst: (u) => resp(402, req402([requirement({ amount: "2000000" })]), u) });
    const { pay, plan } = mkPay(net, { merchant: { pricePin: undefined, maxPerTx: 5_000_000n }, planMax: 5_000_000n });
    await expect(pay.fetch(`${ORIGIN}/a`, {}, { plan })).rejects.toThrow(/human approval refused/);
    expect(net.signed).toHaveLength(0);
  });
});
