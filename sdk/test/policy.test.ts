import { describe, expect, it } from "vitest";
import { evaluate } from "../src/policy/engine.js";
import { MerchantRegistry } from "../src/policy/registry.js";
import { taint } from "../src/guard/taint.js";
import { ATTACKER, merchant, NETWORK, ORIGIN, policy, required, requirement, setup, USDC } from "./fixtures.js";

const now = Date.now();
const url = `${ORIGIN}/v1/prices`;

describe("policy engine: the 402 response is untrusted", () => {
  it("allows a payment that matches the registry, the plan and the pins", () => {
    const { registry, plan } = setup();
    const d = evaluate(policy, registry, { url, required: required(), plan, spentInPeriod: 0n, now });
    expect(d.kind).toBe("allow");
    if (d.kind !== "deny") expect(d.amount).toBe(10_000n);
  });

  const attacks: [string, Parameters<typeof required>[0], RegExp][] = [
    ["swapped payTo", [requirement({ payTo: ATTACKER })], /payTo/],
    ["fake asset", [requirement({ asset: "0x2222222222222222222222222222222222222222" })], /pinned USDC/],
    ["other network", [requirement({ network: "eip155:1" })], /not allowed/],
    ["spoofed EIP-712 domain", [requirement({ extra: { name: "USD Coin Fake", version: "2" } })], /domain name/],
    ["other transfer method", [requirement({ extra: { assetTransferMethod: "permit2" } })], /transfer method/],
    ["unknown scheme", [requirement({ scheme: "upto" })], /scheme/],
    ["huge validity window", [requirement({ maxTimeoutSeconds: 86_400 })], /maxTimeoutSeconds/],
    ["price far above the pin", [requirement({ amount: "50000" })], /pinned price/],
    ["above merchant cap", [requirement({ amount: "6000000" })], /merchant cap/],
  ];

  for (const [name, accepts, reason] of attacks) {
    it(`denies: ${name}`, () => {
      const { registry, plan } = setup();
      const d = evaluate(policy, registry, { url, required: required(accepts), plan, spentInPeriod: 0n, now });
      expect(d.kind).toBe("deny");
      expect(d.reasons.join(" ")).toMatch(reason);
    });
  }

  it("picks the honest option when a server mixes honest and malicious ones", () => {
    const { registry, plan } = setup();
    const accepts = [requirement({ payTo: ATTACKER, amount: "1" }), requirement()];
    const d = evaluate(policy, registry, { url, required: required(accepts), plan, spentInPeriod: 0n, now });
    expect(d.kind).toBe("allow");
    if (d.kind !== "deny") expect(d.requirement.payTo).toBe(accepts[1]!.payTo);
  });

  it("denies x402 v1 and unknown origins", () => {
    const { registry, plan } = setup();
    expect(evaluate(policy, registry, { url, required: required(undefined, 1), plan, spentInPeriod: 0n, now }).kind).toBe("deny");
    const other = evaluate(policy, registry, { url: "https://evil.example/pay", required: required(), plan, spentInPeriod: 0n, now });
    expect(other.reasons.join()).toMatch(/not an approved merchant/);
  });

  it("enforces the sealed plan and the period budget", () => {
    const { registry, plan } = setup();
    expect(plan.reserve(ORIGIN, 995_000n)).toBe(true);
    expect(evaluate(policy, registry, { url, required: required(), plan, spentInPeriod: 0n, now }).reasons.join()).toMatch(/sealed plan/);
    const fresh = setup();
    const d = evaluate(policy, fresh.registry, { url, required: required(), plan: fresh.plan, spentInPeriod: 19_995_000n, now });
    expect(d.reasons.join()).toMatch(/period budget/);
  });

  it("asks a human above the approval threshold", () => {
    const m = merchant({ pricePin: undefined });
    const { registry, plan } = setup(m);
    const bigPlan = plan; // plan budget is 1 USDC; threshold is 1 USDC, so test at the edge
    const d = evaluate({ ...policy, approvalThreshold: 5_000n }, registry, { url, required: required(), plan: bigPlan, spentInPeriod: 0n, now });
    expect(d.kind).toBe("needsApproval");
  });

  it("an expired plan cannot pay", () => {
    const { registry, plan } = setup();
    const d = evaluate(policy, registry, { url, required: required(), plan, spentInPeriod: 0n, now: plan.expiresAt + 1 });
    expect(d.kind).toBe("deny");
  });
});

describe("registry", () => {
  it("resolves tainted origins only on exact match", () => {
    const registry = new MerchantRegistry([merchant()]);
    expect(registry.resolve(taint(ORIGIN, "web"))?.payTo).toBe(merchant().payTo);
    expect(registry.resolve(taint("https://api.pricing-intel.io.evil.com", "web"))).toBeUndefined();
    expect(registry.resolve(taint("http://api.pricing-intel.io", "web"))).toBeUndefined();
    expect(registry.resolve(taint("not a url", "web"))).toBeUndefined();
  });

  it("refuses plain-http merchants except localhost", () => {
    expect(() => new MerchantRegistry([merchant({ origin: "http://shop.example" })])).toThrow(/non-https/);
    expect(() => new MerchantRegistry([merchant({ origin: "http://127.0.0.1:8080" })])).not.toThrow();
  });

  it("pins USDC per network", () => {
    expect(USDC.asset).toBe("0x036CbD53842c5426634e7929541eC2318f3dCF7e");
    expect(NETWORK).toBe("eip155:84532");
  });
});
