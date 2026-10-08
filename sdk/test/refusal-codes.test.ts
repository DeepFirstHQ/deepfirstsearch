import { afterEach, describe, expect, it } from "vitest";
import { createAgentPay, type AgentPayOptions } from "../src/x402/client.js";
import { evaluate, type PolicyConfig } from "../src/policy/engine.js";
import { MerchantRegistry, type Merchant } from "../src/policy/registry.js";
import { commitPlan } from "../src/guard/plan.js";
import { PaymentDeniedError } from "../src/guard/controls.js";
import { verifyChain } from "../src/guard/audit.js";
import { staticListScreen } from "../src/policy/sanctions.js";
import { encodeHeader } from "../src/x402/codec.js";
import { PINNED_USDC } from "../src/policy/networks.js";
import { HEADERS } from "../src/x402/schemas.js";
import { REFUSAL_CODES, isRefusalCode, primaryRefusalCode, refusalAction, type RefusalCode } from "../src/guard/refusal.js";
import * as sdk from "../src/index.js";
import { startMockServer, type MockServer, type Route } from "../src/testing/index.js";
import { ATTACKER, MERCHANT_PAYTO, NETWORK, merchant, ORIGIN, payer, policy, required, requirement, setup, USDC } from "./fixtures.js";
import { HEURIST_402, HEURIST_URL } from "./fixtures-v1.js";

const safeSession = { readsUntrustedInput: true, accessesSensitiveData: false, canPay: true };
const now = Date.now();
const url = `${ORIGIN}/v1/prices`;

let server: MockServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

/** Codes seen anywhere in this file; the last test checks every code was reached. */
const reached = new Set<RefusalCode>();
function denied(d: ReturnType<typeof evaluate>): RefusalCode[] {
  expect(d.kind).toBe("deny");
  if (d.kind !== "deny") return [];
  expect(d.codes).toHaveLength(d.reasons.length);
  d.codes.forEach((c) => reached.add(c));
  return d.codes;
}
async function refusal(p: Promise<unknown>): Promise<PaymentDeniedError> {
  const err = await p.then(() => undefined, (e) => e);
  expect(err).toBeInstanceOf(PaymentDeniedError);
  const e = err as PaymentDeniedError;
  expect(e.codes).toHaveLength(e.reasons.length);
  e.codes.forEach((c) => reached.add(c));
  reached.add(e.code);
  return e;
}

async function mock(route: Route, m: Partial<Merchant> = {}, extra: Partial<AgentPayOptions> = {}) {
  server = await startMockServer({ "/data": route });
  const registry = new MerchantRegistry([{ origin: server.url, payTo: MERCHANT_PAYTO, network: NETWORK, maxPerTx: 1_000_000n, pricePin: 10_000n, ...m }]);
  let payerCalls = 0;
  const pay = createAgentPay({
    registry,
    policy,
    payer: () => {
      payerCalls++;
      return payer;
    },
    session: safeSession,
    settleRetryDelayMs: 1,
    ...extra,
  });
  const plan = pay.commitPlan([{ origin: server.url, maxSpend: 100_000n }], 60_000);
  return { pay, plan, url: `${server.url}/data`, origin: server.url, payerCalls: () => payerCalls };
}

describe("refusal codes: the closed set", () => {
  it("every code has an action and a description, and is exported", () => {
    for (const [code, { action, description }] of Object.entries(REFUSAL_CODES)) {
      expect(["report", "ask_owner", "fix_config", "retry_later"]).toContain(action);
      expect(description.length).toBeGreaterThan(0);
      expect(isRefusalCode(code)).toBe(true);
    }
    expect(isRefusalCode("toString")).toBe(false);
    expect(isRefusalCode("__proto__")).toBe(false);
    expect(sdk.REFUSAL_CODES).toBe(REFUSAL_CODES);
    expect(refusalAction("payee_mismatch")).toBe("report");
    expect(refusalAction("network_mismatch")).toBe("report");
    expect(refusalAction("asset_mismatch")).toBe("report");
    expect(refusalAction("price_changed")).toBe("ask_owner");
    for (const c of ["plan_exhausted", "budget_exhausted"] as const) expect(refusalAction(c)).toBe("retry_later");
    expect(refusalAction("over_cap")).toBe("ask_owner"); // waiting does not lower an amount above the cap
  });

  it("the primary code is the most cautious one, then the first listed; policy_denied only as a fallback", () => {
    expect(primaryRefusalCode(["network_not_allowed", "payee_mismatch"])).toBe("payee_mismatch");
    expect(primaryRefusalCode(["plan_exhausted", "price_changed"])).toBe("price_changed");
    expect(primaryRefusalCode(["policy_denied", "budget_exhausted"])).toBe("budget_exhausted");
    expect(primaryRefusalCode(["asset_mismatch", "payee_mismatch"])).toBe("asset_mismatch");
    expect(primaryRefusalCode([])).toBe("policy_denied");
  });
});

describe("PaymentDeniedError: backwards compatible constructor", () => {
  it("old one-argument calls still work and default to policy_denied", () => {
    const e = new PaymentDeniedError(["custom reason"]);
    expect(e.message).toBe("payment denied: custom reason");
    expect(e.name).toBe("PaymentDeniedError");
    expect(e.reasons).toEqual(["custom reason"]);
    expect(e.codes).toEqual(["policy_denied"]);
    expect(e.code).toBe("policy_denied");
    expect(e.action).toBe("ask_owner");
    expect(e).toBeInstanceOf(Error);
    reached.add(e.code);
  });

  it("codes are parallel to reasons; missing or unknown codes become policy_denied; codes are frozen", () => {
    const e = new PaymentDeniedError(["a", "b", "c"], ["over_cap", "bogus" as RefusalCode]);
    expect(e.codes).toEqual(["over_cap", "policy_denied", "policy_denied"]);
    expect(e.code).toBe("over_cap");
    expect(Object.isFrozen(e.codes)).toBe(true);
    expect(new PaymentDeniedError([]).code).toBe("policy_denied");
  });
});

describe("policy engine: every deny path carries a code", () => {
  const cases: [string, Partial<Parameters<typeof requirement>[0]>, RefusalCode][] = [
    ["swapped payTo", { payTo: ATTACKER }, "payee_mismatch"],
    ["fake asset", { asset: "0x2222222222222222222222222222222222222222" }, "asset_mismatch"],
    ["spoofed EIP-712 domain name", { extra: { name: "USD Coin Fake", version: "2" } }, "asset_mismatch"],
    ["spoofed EIP-712 domain version", { extra: { name: USDC.domain.name, version: "9" } }, "asset_mismatch"],
    ["network not allowed", { network: "eip155:1" }, "network_not_allowed"],
    ["unknown scheme", { scheme: "upto" }, "scheme_unsupported"],
    ["other transfer method", { extra: { assetTransferMethod: "permit2" } }, "scheme_unsupported"],
    ["huge validity window", { maxTimeoutSeconds: 86_400 }, "timeout_out_of_bounds"],
    ["price above the pin", { amount: "50000" }, "price_changed"],
    ["above merchant cap", { amount: "6000000" }, "over_cap"],
    ["zero amount", { amount: "0" }, "invalid_402"],
  ];
  it.each(cases)("%s -> %s", (_name, overrides, code) => {
    const { registry, plan } = setup();
    expect(denied(evaluate(policy, registry, { url, required: required([requirement(overrides)]), plan, spentInPeriod: 0n, now }))).toEqual([code]);
  });

  it("network_mismatch: an allowed network that is not the merchant's", () => {
    const { registry, plan } = setup();
    const both: PolicyConfig = { ...policy, allowedNetworks: [NETWORK, "eip155:8453"] };
    const r = requirement({ network: "eip155:8453", asset: PINNED_USDC["eip155:8453"]!.asset });
    expect(denied(evaluate(both, registry, { url, required: required([r]), plan, spentInPeriod: 0n, now }))).toEqual(["network_mismatch"]);
  });

  it("asset_not_pinned: an allowed merchant network with no USDC pin", () => {
    const m = merchant({ network: "eip155:31337" });
    const { registry, plan } = setup(m);
    const cfg: PolicyConfig = { ...policy, allowedNetworks: ["eip155:31337"] };
    expect(denied(evaluate(cfg, registry, { url, required: required([requirement({ network: "eip155:31337" })]), plan, spentInPeriod: 0n, now }))).toEqual(["asset_not_pinned"]);
  });

  it("unknown_merchant, not_in_plan, plan_expired", () => {
    const { registry, plan } = setup();
    expect(denied(evaluate(policy, registry, { url: "https://evil.example/pay", required: required(), plan, spentInPeriod: 0n, now }))).toEqual(["unknown_merchant"]);
    expect(denied(evaluate(policy, registry, { url, required: required(), plan, spentInPeriod: 0n, now: plan.expiresAt + 1 }))).toEqual(["plan_expired"]);
    const two = new MerchantRegistry([merchant(), merchant({ origin: "https://other.example" })]);
    const narrow = commitPlan(two, [{ origin: "https://other.example", maxSpend: 1_000_000n }], 60_000, now);
    const d = evaluate(policy, two, { url, required: required(), plan: narrow, spentInPeriod: 0n, now });
    expect(denied(d)).toEqual(["not_in_plan"]);
    expect(d.reasons).toEqual(["merchant is not in the sealed plan, or the plan expired"]); // wording unchanged
  });

  it("version_not_allowed: v1 without opt-in, v2 on a v1-only merchant, an unknown version", () => {
    const { registry, plan } = setup();
    expect(denied(evaluate(policy, registry, { url, required: required(undefined, 1), plan, spentInPeriod: 0n, now }))).toEqual(["version_not_allowed"]);
    expect(denied(evaluate(policy, registry, { url, required: required(undefined, 3), plan, spentInPeriod: 0n, now }))).toEqual(["version_not_allowed"]);
    const v1only = setup(merchant({ x402Versions: [1] }));
    expect(denied(evaluate(policy, v1only.registry, { url, required: required(), plan: v1only.plan, spentInPeriod: 0n, now }))).toEqual(["version_not_allowed"]);
  });

  it("plan_exhausted, budget_exhausted, invalid_402 (no options)", () => {
    const { registry, plan } = setup();
    plan.reserve(ORIGIN, 995_000n);
    expect(denied(evaluate(policy, registry, { url, required: required(), plan, spentInPeriod: 0n, now }))).toEqual(["plan_exhausted"]);
    const fresh = setup();
    expect(denied(evaluate(policy, fresh.registry, { url, required: required(), plan: fresh.plan, spentInPeriod: 19_995_000n, now }))).toEqual(["budget_exhausted"]);
    expect(denied(evaluate(policy, fresh.registry, { url, required: required([]), plan: fresh.plan, spentInPeriod: 0n, now }))).toEqual(["invalid_402"]);
  });

  it("several rejected options keep one code per reason, and the redirection wins as primary", () => {
    const { registry, plan } = setup();
    const d = evaluate(policy, registry, { url, required: required([requirement({ network: "eip155:1" }), requirement({ payTo: ATTACKER })]), plan, spentInPeriod: 0n, now });
    expect(denied(d)).toEqual(["network_not_allowed", "payee_mismatch"]);
    if (d.kind === "deny") expect(new PaymentDeniedError(d.reasons, d.codes).code).toBe("payee_mismatch");
  });
});

describe("x402 client: refusals carry codes, in the error and in the audit log", () => {
  it("a live 402 whose price moved away from the pin: price_changed, ask the owner, zero signatures", async () => {
    // The owner pinned 0.01 USDC; the merchant now asks 0.05 (under the per-payment cap, so only the pin catches it).
    const { pay, plan, url, payerCalls } = await mock({ price: 50_000n, payTo: MERCHANT_PAYTO });
    const e = await refusal(pay.fetch(url, {}, { plan }));
    expect(e.code).toBe("price_changed");
    expect(e.codes).toEqual(["price_changed"]);
    expect(e.action).toBe("ask_owner");
    expect(e.reasons).toEqual(["amount 50000 is above the pinned price 10000"]); // wording unchanged
    // Zero signatures: nothing reached the merchant, no payer was requested, nothing signed in the audit log.
    expect(server!.received).toHaveLength(0);
    expect(payerCalls()).toBe(0);
    const types = pay.audit.entries.map((x) => x.event.type);
    expect(types).not.toContain("payment.signed");
    const denial = pay.audit.entries.find((x) => x.event.type === "payment.denied")!;
    expect(denial.event.codes).toEqual(["price_changed"]);
    expect(verifyChain(pay.audit.entries)).toBe(-1);
    expect(plan.remaining(new URL(url).origin)).toBe(100_000n);
  });

  it("the same price move on a replayed live x402 v1 402 (Heurist Mesh): price_changed, zero signatures", async () => {
    const moved = JSON.parse(HEURIST_402);
    moved.accepts = moved.accepts.map((a: Record<string, unknown>) => ({ ...a, maxAmountRequired: "5000" })); // pin is 1000
    const sent: Headers[] = [];
    const f = (async (_u: string, init: RequestInit = {}) => {
      sent.push(new Headers(init.headers));
      return new Response(JSON.stringify(moved), { status: 402, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;
    const origin = new URL(HEURIST_URL).origin;
    const registry = new MerchantRegistry([
      { origin, payTo: "0xA112c9C8BF655c678c768B6fD42a1C6FbfeD7D60", network: "eip155:8453", maxPerTx: 50_000n, pricePin: 1_000n, x402Versions: [1, 2] },
    ]);
    const pay = createAgentPay({
      registry,
      policy: { allowedNetworks: ["eip155:8453"] },
      payer: () => {
        throw new Error("payer must not be requested");
      },
      session: safeSession,
      fetch: f,
    });
    const plan = pay.commitPlan([{ origin, maxSpend: 100_000n }], 60_000);
    const e = await refusal(pay.fetch(HEURIST_URL, { method: "POST" }, { plan }));
    expect(e.code).toBe("price_changed");
    expect(sent.every((h) => h.get("X-PAYMENT") === null && h.get(HEADERS.signature) === null)).toBe(true);
    expect(pay.audit.entries.map((x) => x.event.type)).not.toContain("payment.signed");
  });

  it("v1 refusals carry codes too: payee, no opt-in, unknown network", async () => {
    let r = await mock({ price: 10_000n, payTo: MERCHANT_PAYTO, x402Version: 1, tamper: (q) => ({ ...q, payTo: ATTACKER }) }, { x402Versions: [1, 2] });
    expect((await refusal(r.pay.fetch(r.url, {}, { plan: r.plan }))).code).toBe("payee_mismatch");
    expect(server!.receivedV1).toHaveLength(0);
    await server!.close();

    r = await mock({ price: 10_000n, payTo: MERCHANT_PAYTO, x402Version: 1 });
    expect((await refusal(r.pay.fetch(r.url, {}, { plan: r.plan }))).code).toBe("version_not_allowed");
    await server!.close();

    r = await mock(
      { price: 10_000n, payTo: MERCHANT_PAYTO, x402Version: 1, tamperV1: (b) => ({ ...b, accepts: b.accepts.map((a) => ({ ...a, network: "polygon" })) }) },
      { x402Versions: [1, 2] },
    );
    const e = await refusal(r.pay.fetch(r.url, {}, { plan: r.plan }));
    expect(e.codes).toEqual(["network_not_allowed"]);
    expect(e.reasons).toEqual(["x402 v1 network polygon is not supported"]);
    expect(server!.receivedV1).toHaveLength(0);
  });

  it("a skipped v1 option next to a rejected one keeps both codes, and the payee mismatch wins", async () => {
    const solana = { scheme: "exact", network: "solana", maxAmountRequired: "1", payTo: "CugLY5tH7qnGqTrZmxRH1iLrT2WrVZy6awbfExFBzT8P", maxTimeoutSeconds: 300, asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" };
    const r = await mock(
      { price: 10_000n, payTo: MERCHANT_PAYTO, x402Version: 1, tamper: (q) => ({ ...q, payTo: ATTACKER }), tamperV1: (b) => ({ ...b, accepts: [solana, ...b.accepts] }) },
      { x402Versions: [1, 2] },
    );
    const e = await refusal(r.pay.fetch(r.url, {}, { plan: r.plan }));
    expect(e.codes).toEqual(["payee_mismatch", "network_not_allowed"]);
    expect(e.code).toBe("payee_mismatch");
    expect(e.action).toBe("report");
  });

  it("client-side paths: sanctions, human refusal, plan and period reservations, invalid 402s, redirects, non-https", async () => {
    let r = await mock({ price: 10_000n, payTo: MERCHANT_PAYTO }, {}, { screen: staticListScreen([MERCHANT_PAYTO]) });
    let e = await refusal(r.pay.fetch(r.url, {}, { plan: r.plan }));
    expect(e.code).toBe("sanctioned_payee");
    expect(r.pay.audit.entries.find((x) => x.event.type === "payment.denied")!.event.codes).toEqual(["sanctioned_payee"]);
    await server!.close();

    r = await mock({ price: 10_000n, payTo: MERCHANT_PAYTO }, {}, { policy: { ...policy, approvalThreshold: 1n } });
    e = await refusal(r.pay.fetch(r.url, {}, { plan: r.plan }));
    expect(e.code).toBe("human_refused");
    expect(e.reasons[0]).toBe("human approval refused");
    expect(e.codes.every((c) => c === "human_refused")).toBe(true);
    expect(server!.received).toHaveLength(0);
    await server!.close();

    // The reservation step (after the policy) also has codes.
    r = await mock({ price: 10_000n, payTo: MERCHANT_PAYTO });
    const plan = r.pay.commitPlan([{ origin: r.origin, maxSpend: 10_000n }], 60_000);
    plan.reserve(r.origin, 5_000n);
    // evaluate sees the plan as too small first; that is plan_exhausted as well.
    expect((await refusal(r.pay.fetch(r.url, {}, { plan }))).code).toBe("plan_exhausted");
    await server!.close();

    // An unreadable 402 header.
    const bad = (async () => new Response("", { status: 402, headers: { [HEADERS.required]: "%%%not-base64%%%" } })) as unknown as typeof fetch;
    const reg = new MerchantRegistry([merchant()]);
    let pay = createAgentPay({ registry: reg, policy, payer: () => payer, session: safeSession, fetch: bad });
    let p = pay.commitPlan([{ origin: ORIGIN, maxSpend: 100_000n }], 60_000);
    e = await refusal(pay.fetch(url, {}, { plan: p }));
    expect(e.code).toBe("invalid_402");
    expect(pay.audit.entries.find((x) => x.event.type === "payment.denied")!.event.codes).toEqual(["invalid_402"]);

    // A 402 reached through a cross-origin redirect.
    const redirected = (async () => {
      const res = new Response("", { status: 402, headers: { [HEADERS.required]: encodeHeader(required()) } });
      Object.defineProperty(res, "redirected", { value: true });
      Object.defineProperty(res, "url", { value: "https://elsewhere.example/x" });
      return res;
    }) as unknown as typeof fetch;
    pay = createAgentPay({ registry: reg, policy, payer: () => payer, session: safeSession, fetch: redirected });
    p = pay.commitPlan([{ origin: ORIGIN, maxSpend: 100_000n }], 60_000);
    expect((await refusal(pay.fetch(url, {}, { plan: p }))).code).toBe("invalid_402");

    // A non-https URL answering 402.
    const plain = (async () => new Response("", { status: 402, headers: { [HEADERS.required]: encodeHeader(required()) } })) as unknown as typeof fetch;
    pay = createAgentPay({ registry: reg, policy, payer: () => payer, session: safeSession, fetch: plain });
    p = pay.commitPlan([{ origin: ORIGIN, maxSpend: 100_000n }], 60_000);
    e = await refusal(pay.fetch("http://insecure.example/x", {}, { plan: p }));
    expect(e.code).toBe("unknown_merchant");
    expect(e.reasons[0]).toMatch(/refusing non-https origin/);
  });

  it("the period budget and the plan, as reserved by concurrent payments, carry codes", async () => {
    // Two concurrent payments that each fit, but not together: the first reserves synchronously, so the second is refused.
    const r = await mock({ price: 10_000n, payTo: MERCHANT_PAYTO }, {}, { policy: { ...policy, periodBudget: { amount: 15_000n, periodMs: 60_000 } } });
    const results = await Promise.allSettled([r.pay.fetch(r.url, {}, { plan: r.plan }), r.pay.fetch(r.url, {}, { plan: r.plan })]);
    const err = results.find((x) => x.status === "rejected") as PromiseRejectedResult;
    expect(err).toBeDefined();
    const e = await refusal(Promise.reject(err.reason));
    expect(e.code).toBe("budget_exhausted");
    await server!.close();

    const r2 = await mock({ price: 10_000n, payTo: MERCHANT_PAYTO });
    const small = r2.pay.commitPlan([{ origin: r2.origin, maxSpend: 15_000n }], 60_000);
    const both = await Promise.allSettled([r2.pay.fetch(r2.url, {}, { plan: small }), r2.pay.fetch(r2.url, {}, { plan: small })]);
    const err2 = both.find((x) => x.status === "rejected") as PromiseRejectedResult;
    const e2 = await refusal(Promise.reject(err2.reason));
    expect(e2.code).toBe("plan_exhausted");
    expect(server!.received).toHaveLength(1); // exactly one payment signed and sent
  });

  it("a plan that expires while waiting for approval: plan_expired before signing", async () => {
    let t = Date.now();
    const r = await mock({ price: 10_000n, payTo: MERCHANT_PAYTO }, {}, {
      now: () => t,
      policy: { ...policy, approvalThreshold: 1n },
      approve: async () => {
        t += 120_000; // the human took two minutes; the plan lived one
        return true;
      },
    });
    const e = await refusal(r.pay.fetch(r.url, {}, { plan: r.plan }));
    expect(e.code).toBe("plan_expired");
    expect(e.reasons).toEqual(["sealed plan expired before signing"]);
    expect(server!.received).toHaveLength(0);
  });
});

describe("coverage", () => {
  it("every refusal code was reached by a test above", () => {
    expect([...reached].sort()).toEqual(Object.keys(REFUSAL_CODES).sort());
  });
});
