import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { agentSafeGuard, AuditLog, commitPlan, MerchantRegistry } from "../src/index.js";
import { startMockServer, type MockServer } from "../src/testing/index.js";

const MERCHANT = "0x1111111111111111111111111111111111111111";
const ATTACKER = "0x9999999999999999999999999999999999999999";
const NETWORK = "eip155:84532";
let m: MockServer;
let other: MockServer;

beforeAll(async () => {
  m = await startMockServer({
    "/ok": { price: 1_000n, payTo: MERCHANT },
    "/evil": { price: 1_000n, payTo: MERCHANT, tamper: (r) => ({ ...r, payTo: ATTACKER }) },
    "/pricey": { price: 4_000n, payTo: MERCHANT },
  });
  // Another origin that serves the registered merchant's terms: the payee is right, the origin is not.
  other = await startMockServer({ "/ok": { price: 1_000n, payTo: MERCHANT } });
});
afterAll(async () => {
  await m.close();
  await other.close();
});

function setup(opts: { planSpend?: bigint; approve?: () => Promise<boolean>; approvalThreshold?: bigint; origin?: string } = {}) {
  const registry = new MerchantRegistry([{ origin: m.url, payTo: MERCHANT, network: NETWORK, maxPerTx: 5_000n, pricePin: 3_000n }]);
  const plan = commitPlan(registry, [{ origin: m.url, maxSpend: opts.planSpend ?? 10_000n }], 3_600_000);
  const audit = new AuditLog();
  const guard = agentSafeGuard({
    registry,
    plan,
    audit,
    policy: { allowedNetworks: [NETWORK], ...(opts.approvalThreshold !== undefined ? { approvalThreshold: opts.approvalThreshold } : {}) },
    ...(opts.approve ? { approve: opts.approve } : {}),
    ...(opts.origin ? { origin: opts.origin } : {}),
  });
  const client = guard.install(x402Client.fromConfig({ schemes: [{ network: "eip155:*", client: new ExactEvmScheme(privateKeyToAccount(generatePrivateKey())) }] }));
  const sent: Request[] = [];
  const spy = (async (input: RequestInfo | URL, init?: RequestInit) => {
    sent.push(new Request(input, init));
    return fetch(input, init);
  }) as typeof fetch;
  return { guard, client, plan, audit, sent, pay: guard.fetch(wrapFetchWithPayment(spy, client)), raw: wrapFetchWithPayment(spy, client) };
}
const signed = (sent: Request[]) => sent.filter((r) => r.headers.has("PAYMENT-SIGNATURE") || r.headers.has("X-PAYMENT")).length;

describe("agentSafeGuard on the official x402 client", () => {
  it("pays a registered merchant within its pins and spends the plan", async () => {
    const t = setup();
    const res = await t.pay(`${m.url}/ok`);
    expect(res.status).toBe(200);
    expect(t.plan.remaining(m.url)).toBe(9_000n);
    expect(t.audit.entries.map((e) => e.event.type)).toEqual(["payment.signed", "payment.settled"]);
  });

  it("refuses a 402 that names another payee, with nothing signed", async () => {
    const t = setup();
    await expect(t.pay(`${m.url}/evil`)).rejects.toThrow(/payee_mismatch/);
    expect(signed(t.sent)).toBe(0);
    expect(t.plan.remaining(m.url)).toBe(10_000n);
  });

  it("refuses a price above the pin", async () => {
    const t = setup();
    await expect(t.pay(`${m.url}/pricey`)).rejects.toThrow(/price_changed/);
    expect(signed(t.sent)).toBe(0);
  });

  it("judges the origin actually requested, never the one the 402 claims", async () => {
    const t = setup();
    await expect(t.pay(`${other.url}/ok`)).rejects.toThrow(/unknown_merchant/);
    expect(signed(t.sent)).toBe(0);
  });

  it("refuses to pay through a fetch that was not wrapped with guard.fetch", async () => {
    const t = setup();
    await expect(t.raw(`${m.url}/ok`)).rejects.toThrow(/not wrapped with guard\.fetch/);
    expect(signed(t.sent)).toBe(0);
  });

  it("reserves the plan before signing, so parallel payments can't overspend it", async () => {
    const t = setup({ planSpend: 2_000n });
    const results = await Promise.allSettled([1, 2, 3].map(() => t.pay(`${m.url}/ok`)));
    expect(results.filter((r) => r.status === "fulfilled").length).toBe(2);
    expect(results.filter((r) => r.status === "rejected" && /plan_exhausted/.test(String(r.reason))).length).toBe(1);
    expect(signed(t.sent)).toBe(2);
    expect(t.plan.remaining(m.url)).toBe(0n);
  });

  it("asks the owner above the approval threshold, and gives the budget back on a no", async () => {
    const no = setup({ approvalThreshold: 500n, approve: async () => false });
    await expect(no.pay(`${m.url}/ok`)).rejects.toThrow(/approval_required/);
    expect(signed(no.sent)).toBe(0);
    expect(no.plan.remaining(m.url)).toBe(10_000n);
    const yes = setup({ approvalThreshold: 500n, approve: async () => true });
    expect((await yes.pay(`${m.url}/ok`)).status).toBe(200);
  });

  // OpenAI-style clients wrap their own fetch around one base URL: the owner names that origin instead.
  it("fixed origin: judges a client that wraps its own fetch against the configured base URL", async () => {
    const t = setup({ origin: m.url });
    expect((await t.raw(`${m.url}/ok`)).status).toBe(200);
    expect(t.plan.remaining(m.url)).toBe(9_000n);
    await expect(t.raw(`${m.url}/evil`)).rejects.toThrow(/payee_mismatch/);
    expect(signed(t.sent)).toBe(1);
    // guard.fetch still wins when present: the requested origin is judged, not the configured one.
    await expect(t.pay(`${other.url}/ok`)).rejects.toThrow(/unknown_merchant/);
  });
});
