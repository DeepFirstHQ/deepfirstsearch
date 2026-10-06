import { describe, expect, it } from "vitest";
import { PaymentBlockedError } from "../../src/guard/controls.js";
import { ORIGIN } from "../fixtures.js";
import { fakeNet, mkPay, ok, resp } from "./helpers.js";

// Targets the uncommitted settlement-retry change in src/x402/client.ts (working tree after 6acb9f7).
describe("settlement retries (working-tree change)", () => {
  it("regression: retries reuse one authorization and stop on success", async () => {
    let n = 0;
    const net = fakeNet({ onPaid: (u) => (++n < 2 ? resp(502, {}, u) : resp(200, { "PAYMENT-RESPONSE": ok() }, u)) });
    const { pay, plan } = mkPay(net);
    const r = await pay.fetch(`${ORIGIN}/a`, {}, { plan });
    expect(r.payment?.settlement.success).toBe(true);
    expect(net.signed).toHaveLength(2);
    expect(new Set(net.signed.map((s) => s.payload.authorization.nonce)).size).toBe(1);
    expect(plan.remaining(ORIGIN)).toBe(20_000n);
  });

  it("SDK-I-10 retries replay the whole request (method + body): non-idempotent side effects repeat", async () => {
    const net = fakeNet({ onPaid: (u) => resp(500, {}, u) });
    const { pay, plan } = mkPay(net, { settleRetries: 2 } as never);
    await expect(pay.fetch(`${ORIGIN}/orders`, { method: "POST", body: '{"buy":1}' }, { plan })).rejects.toBeInstanceOf(PaymentBlockedError);
    const posts = net.sent.filter((s) => s.payload && s.init.method === "POST" && s.init.body === '{"buy":1}');
    expect(posts).toHaveLength(3);
  });

  it("SDK-I-10 a kill during the retry backoff writes payment.failed for the sent authorization", async () => {
    let k!: () => void;
    const net = fakeNet({ onPaid: (u) => (k(), resp(500, {}, u)) });
    const { pay, plan } = mkPay(net);
    k = () => pay.kill("incident");
    await expect(pay.fetch(`${ORIGIN}/a`, {}, { plan })).rejects.toThrow(/kill switch/);
    const types = pay.audit.entries.map((e) => e.event.type);
    expect(types).toContain("payment.signed");
    expect(types.at(-1)).toBe("payment.failed");
    expect(net.signed).toHaveLength(1); // no retry after the kill
    expect(plan.remaining(ORIGIN)).toBe(20_000n); // the sent authorization stays accounted
  });

  it("SDK-I-10 invalid settleRetries / settleRetryDelayMs throw at createAgentPay(), before anything is signed", () => {
    for (const bad of [-1, 1.5, 11, Number.NaN]) {
      const net = fakeNet();
      expect(() => mkPay(net, { settleRetries: bad })).toThrow(/settleRetries/);
      expect(net.sent).toHaveLength(0);
    }
    expect(() => mkPay(fakeNet(), { settleRetryDelayMs: -1 })).toThrow(/settleRetryDelayMs/);
    expect(() => mkPay(fakeNet(), { settleRetries: 0 })).not.toThrow();
  });
});
