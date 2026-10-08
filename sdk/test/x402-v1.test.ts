import { afterEach, describe, expect, it } from "vitest";
import { verifyTypedData } from "viem";
import { createAgentPay, type AgentPayOptions } from "../src/x402/client.js";
import { evaluate } from "../src/policy/engine.js";
import { MerchantRegistry, type Merchant } from "../src/policy/registry.js";
import { commitPlan } from "../src/guard/plan.js";
import { PaymentBlockedError, PaymentDeniedError } from "../src/guard/controls.js";
import { verifyChain } from "../src/guard/audit.js";
import { decodeHeader, encodeHeader } from "../src/x402/codec.js";
import { PINNED_USDC } from "../src/policy/networks.js";
import { TRANSFER_WITH_AUTHORIZATION_TYPES, usdcDomain } from "../src/x402/exactEvm.js";
import { PaymentPayloadV1, PaymentRequiredV1, v1NetworkToCaip2 } from "../src/x402/schemas.js";
import { normalizeV1, MAX_V1_BODY_BYTES } from "../src/x402/v1.js";
import { startMockServer, type MockServer, type Route } from "../src/testing/index.js";
import { ATTACKER, MERCHANT_PAYTO, NETWORK, payer, policy } from "./fixtures.js";
import { BROWSERBASE_402_A, BROWSERBASE_402_B, BROWSERBASE_URL, HEURIST_402, HEURIST_URL } from "./fixtures-v1.js";

const safeSession = { readsUntrustedInput: true, accessesSensitiveData: false, canPay: true };
const BASE = "eip155:8453";
const HEURIST_PAYTO = "0xA112c9C8BF655c678c768B6fD42a1C6FbfeD7D60";
const BB_A_PAYTO = "0x727559BCC8D1d88D7F343C3cE12FfE84ad25BDa1";

let server: MockServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function mock(route: Route, merchant: Partial<Merchant> = {}, extra: Partial<AgentPayOptions> = {}) {
  server = await startMockServer({ "/data": route });
  const registry = new MerchantRegistry([
    { origin: server.url, payTo: MERCHANT_PAYTO, network: NETWORK, maxPerTx: 1_000_000n, pricePin: 10_000n, ...merchant },
  ]);
  const pay = createAgentPay({ registry, policy, payer: () => payer, session: safeSession, settleRetryDelayMs: 1, ...extra });
  const plan = pay.commitPlan([{ origin: server.url, maxSpend: 100_000n }], 60_000);
  return { pay, plan, url: `${server.url}/data`, origin: server.url };
}

/** Replays a captured 402 body for the unpaid request; records every payment header that leaves the SDK. */
function replay(bodies: string[], receipt?: (p: PaymentPayloadV1) => Record<string, string>) {
  const sent: { headers: Headers }[] = [];
  const paid: PaymentPayloadV1[] = [];
  let i = 0;
  const f = (async (_input: string, init: RequestInit = {}) => {
    const h = new Headers(init.headers);
    sent.push({ headers: h });
    const x = h.get("X-PAYMENT");
    if (x) {
      const p = decodeHeader(x, PaymentPayloadV1);
      paid.push(p);
      const ok = { success: true, transaction: `0x${"cd".repeat(32)}`, network: "base", payer: p.payload.authorization.from };
      return new Response('{"projects":[]}', { status: 200, headers: receipt ? receipt(p) : { "X-PAYMENT-RESPONSE": encodeHeader(ok) } });
    }
    const body = bodies[Math.min(i++, bodies.length - 1)]!;
    return new Response(body, { status: 402, headers: { "Content-Type": "application/json; charset=utf-8" } });
  }) as unknown as typeof fetch;
  return { fetch: f, sent, paid };
}

function liveClient(url: string, merchant: Partial<Merchant>, net: { fetch: typeof fetch }, extra: Partial<AgentPayOptions> = {}) {
  const origin = new URL(url).origin;
  const registry = new MerchantRegistry([{ origin, payTo: HEURIST_PAYTO, network: BASE, maxPerTx: 50_000n, pricePin: 1_000n, ...merchant }]);
  const pay = createAgentPay({ registry, policy: { allowedNetworks: [BASE] }, payer: () => payer, session: safeSession, fetch: net.fetch, settleRetryDelayMs: 1, ...extra });
  const plan = pay.commitPlan([{ origin, maxSpend: 100_000n }], 60_000);
  return { pay, plan, origin };
}

describe("x402 v1 schemas and network table (real 402s captured 2026-10-08)", () => {
  it("parses Heurist Mesh's 402 and normalizes it: base -> eip155:8453, maxAmountRequired -> amount", () => {
    const v1 = PaymentRequiredV1.parse(JSON.parse(HEURIST_402));
    const { required, skipped } = normalizeV1(v1);
    expect(skipped).toEqual([]);
    expect(required).toEqual({
      x402Version: 1,
      accepts: [{ scheme: "exact", network: BASE, amount: "1000", asset: PINNED_USDC[BASE]!.asset, payTo: HEURIST_PAYTO, maxTimeoutSeconds: 120, extra: { name: "USD Coin", version: "2" } }],
    });
  });

  it("parses Browserbase's 402 (top-level payToAddress, Solana option) and skips the Solana option", () => {
    const { required, skipped } = normalizeV1(PaymentRequiredV1.parse(JSON.parse(BROWSERBASE_402_A)));
    expect(required.accepts).toHaveLength(1);
    expect(required.accepts[0]).toMatchObject({ network: BASE, payTo: BB_A_PAYTO, amount: "10000" });
    expect(skipped).toEqual(["x402 v1 network solana is not supported"]);
  });

  it("maps only the fixed table; prototype names and unknown names map to nothing", () => {
    expect(v1NetworkToCaip2("base")).toBe("eip155:8453");
    expect(v1NetworkToCaip2("base-sepolia")).toBe("eip155:84532");
    for (const n of ["solana", "polygon", "ethereum", "Base", "constructor", "toString", "__proto__", "eip155:8453"]) expect(v1NetworkToCaip2(n)).toBeUndefined();
  });

  it("rejects a payToAddress that disagrees with the offered payTo, unknown top-level fields, and non-hex EVM payees", () => {
    const bb = JSON.parse(BROWSERBASE_402_A);
    expect(() => PaymentRequiredV1.parse({ ...bb, payToAddress: ATTACKER })).toThrow(/payToAddress/);
    expect(() => PaymentRequiredV1.parse({ ...bb, payTo: ATTACKER })).toThrow();
    expect(() => PaymentRequiredV1.parse({ ...bb, accepts: [{ ...bb.accepts[0], payTo: "not-an-address" }] })).toThrow(/20-byte hex/);
    expect(() => PaymentRequiredV1.parse({ ...bb, accepts: [{ ...bb.accepts[0], amount: "1" }] })).toThrow();
  });

  it("the policy refuses a v1 402 for a merchant that did not opt in, and names the option", () => {
    const { required } = normalizeV1(PaymentRequiredV1.parse(JSON.parse(HEURIST_402)));
    const origin = new URL(HEURIST_URL).origin;
    const mk = (x402Versions?: (1 | 2)[]) => new MerchantRegistry([{ origin, payTo: HEURIST_PAYTO, network: BASE, maxPerTx: 10_000n, pricePin: 1_000n, ...(x402Versions ? { x402Versions } : {}) }]);
    for (const [reg, kind] of [[mk(), "deny"], [mk([2]), "deny"], [mk([1, 2]), "allow"], [mk([1]), "allow"]] as const) {
      const plan = commitPlan(reg, [{ origin, maxSpend: 10_000n }], 60_000);
      const d = evaluate({ allowedNetworks: [BASE] }, reg, { url: HEURIST_URL, required, plan, spentInPeriod: 0n, now: Date.now() });
      expect(d.kind).toBe(kind);
      if (d.kind === "deny") expect(d.reasons[0]).toMatch(/x402Versions: \[1, 2\]/);
    }
  });

  it("validates x402Versions in the registry", () => {
    const base = { origin: "https://a.example", payTo: MERCHANT_PAYTO, network: NETWORK, maxPerTx: 1n };
    for (const bad of [[], [3], [1, 1], [0], ["1"]]) {
      expect(() => new MerchantRegistry([{ ...base, x402Versions: bad as never }])).toThrow(/x402Versions/);
    }
    expect(new MerchantRegistry([{ ...base, x402Versions: [1, 2] }]).forUrl("https://a.example/x")?.x402Versions).toEqual([1, 2]);
  });
});

describe("x402 v1 against replayed real 402s (local mock fetch, no network)", () => {
  it("Heurist without opt-in: refused with a reason naming x402Versions, nothing signed", async () => {
    const net = replay([HEURIST_402]);
    const { pay, plan, origin } = liveClient(HEURIST_URL, {}, net, { payer: () => { throw new Error("payer must not be requested"); } });
    const err = await pay.fetch(HEURIST_URL, { method: "POST" }, { plan }).catch((e) => e);
    expect(err).toBeInstanceOf(PaymentDeniedError);
    expect(err.message).toMatch(/x402 v1 .*x402Versions: \[1, 2\]/);
    expect(net.paid).toHaveLength(0);
    expect(net.sent).toHaveLength(1);
    expect(plan.remaining(origin)).toBe(100_000n);
  });

  it("Heurist with opt-in: one X-PAYMENT in the reference v1 format, signed with the pinned domain, receipt read", async () => {
    const net = replay([HEURIST_402]);
    const { pay, plan, origin } = liveClient(HEURIST_URL, { x402Versions: [1, 2] }, net);
    const res = await pay.fetch(HEURIST_URL, { method: "POST", body: "{}" }, { plan });
    expect(res.status).toBe(200);
    expect(res.payment?.amount).toBe(1_000n);
    expect(res.payment?.settlement).toMatchObject({ success: true, network: BASE, transaction: `0x${"cd".repeat(32)}` });
    expect(plan.remaining(origin)).toBe(99_000n);

    expect(net.paid).toHaveLength(1);
    const paidReq = net.sent[1]!.headers;
    expect(paidReq.get("PAYMENT-SIGNATURE")).toBeNull();
    const raw = JSON.parse(Buffer.from(paidReq.get("X-PAYMENT")!, "base64").toString("utf8"));
    // Exactly the reference v1 client's shape: no accepted, no resource, no outputSchema echoed back.
    expect(Object.keys(raw).sort()).toEqual(["network", "payload", "scheme", "x402Version"]);
    expect(Object.keys(raw.payload).sort()).toEqual(["authorization", "signature"]);
    expect(raw).toMatchObject({ x402Version: 1, scheme: "exact", network: "base" });
    const a = raw.payload.authorization;
    expect(Object.keys(a).sort()).toEqual(["from", "nonce", "to", "validAfter", "validBefore", "value"]);
    expect(a).toMatchObject({ from: payer.address, to: HEURIST_PAYTO, value: "1000" });
    expect(Number(a.validBefore) - Number(a.validAfter)).toBe(120 + 30);
    const valid = await verifyTypedData({
      address: payer.address,
      domain: usdcDomain(PINNED_USDC[BASE]!),
      types: TRANSFER_WITH_AUTHORIZATION_TYPES,
      primaryType: "TransferWithAuthorization",
      message: { from: a.from, to: a.to, value: BigInt(a.value), validAfter: BigInt(a.validAfter), validBefore: BigInt(a.validBefore), nonce: a.nonce },
      signature: raw.payload.signature,
    });
    expect(valid).toBe(true);
    expect(pay.audit.entries.map((e) => e.event.type)).toEqual(["plan.sealed", "payment.signed", "payment.settled"]);
    expect(verifyChain(pay.audit.entries)).toBe(-1);
  });

  it("Heurist with opt-in but the receipt network differs from what was signed: not counted as settled", async () => {
    const net = replay([HEURIST_402], (p) => ({ "X-PAYMENT-RESPONSE": encodeHeader({ success: true, transaction: "0x01", network: "base-sepolia", payer: p.payload.authorization.from }) }));
    const { pay, plan } = liveClient(HEURIST_URL, { x402Versions: [1, 2] }, net);
    await expect(pay.fetch(HEURIST_URL, { method: "POST" }, { plan })).rejects.toThrow(/different network/);
    expect(new Set(net.paid.map((p) => p.payload.signature)).size).toBe(1);
  });

  it("Browserbase (payTo rotates per request) stays refused with a payee-differs reason, zero signatures", async () => {
    // The owner pinned the address from the first 402; the next 402 offers a fresh deposit address.
    const net = replay([BROWSERBASE_402_B]);
    const { pay, plan } = liveClient(BROWSERBASE_URL, { payTo: BB_A_PAYTO, x402Versions: [1, 2], pricePin: 10_000n }, net, {
      payer: () => { throw new Error("payer must not be requested"); },
    });
    const err = await pay.fetch(BROWSERBASE_URL, { method: "POST", body: '{"estimatedMinutes":5}' }, { plan }).catch((e) => e);
    expect(err).toBeInstanceOf(PaymentDeniedError);
    expect(err.reasons).toContain("payTo 0xd470afAf28BFb65C2FA7767664Fde1915c80d8fD is not the merchant's registered address");
    expect(err.reasons).toContain("x402 v1 network solana is not supported");
    expect(net.paid).toHaveLength(0);
    expect(net.sent.every((s) => s.headers.get("X-PAYMENT") === null)).toBe(true);
  });
});

describe("x402 v1 with the mock merchant", () => {
  it("is refused without opt-in, and the mock receives no payment", async () => {
    const { pay, plan } = await mock({ price: 10_000n, payTo: MERCHANT_PAYTO, x402Version: 1 });
    await expect(pay.fetch(`${server!.url}/data`, {}, { plan })).rejects.toThrow(/x402Versions: \[1, 2\]/);
    expect(server!.receivedV1).toHaveLength(0);
    expect(server!.received).toHaveLength(0);
  });

  it("pays with opt-in: X-PAYMENT on base-sepolia, X-PAYMENT-RESPONSE parsed, budgets charged once", async () => {
    const { pay, plan, url, origin } = await mock({ price: 10_000n, payTo: MERCHANT_PAYTO, x402Version: 1, body: '{"v":1}' }, { x402Versions: [1, 2] });
    const res = await pay.fetch(url, {}, { plan });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{"v":1}');
    expect(res.payment?.settlement).toMatchObject({ success: true, network: NETWORK });
    expect(server!.receivedV1).toHaveLength(1);
    expect(server!.receivedV1[0]).toMatchObject({ x402Version: 1, scheme: "exact", network: "base-sepolia" });
    expect(server!.receivedV1[0]!.payload.authorization.to).toBe(MERCHANT_PAYTO);
    expect(server!.received).toHaveLength(0);
    expect(plan.remaining(origin)).toBe(90_000n);
  });

  it("v1-only merchant ([1]) refuses a v2 402", async () => {
    const { pay, plan } = await mock({ price: 10_000n, payTo: MERCHANT_PAYTO }, { x402Versions: [1] });
    await expect(pay.fetch(`${server!.url}/data`, {}, { plan })).rejects.toThrow(/allows only x402Versions \[1\]/);
    expect(server!.received).toHaveLength(0);
  });

  it("ignores a Solana option next to the EVM one", async () => {
    const solana = { scheme: "exact", network: "solana", maxAmountRequired: "1", payTo: "CugLY5tH7qnGqTrZmxRH1iLrT2WrVZy6awbfExFBzT8P", maxTimeoutSeconds: 300, asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", extra: { feePayer: "Hc3sdEAsCGQcpgfivywog9uwtk8gUBUZgsxdME1EJy88" } };
    const { pay, plan, url } = await mock(
      { price: 10_000n, payTo: MERCHANT_PAYTO, x402Version: 1, tamperV1: (b) => ({ ...b, accepts: [solana, ...b.accepts] }) },
      { x402Versions: [1, 2] },
    );
    expect((await pay.fetch(url, {}, { plan })).payment?.amount).toBe(10_000n); // not the cheaper Solana option
    expect(server!.receivedV1).toHaveLength(1);
    expect(server!.receivedV1[0]!.network).toBe("base-sepolia");
  });

  it.each(["polygon", "base-mainnet", "constructor", "ethereum"])("refuses an unknown v1 network (%s) before signing", async (network) => {
    const { pay, plan, url } = await mock(
      { price: 10_000n, payTo: MERCHANT_PAYTO, x402Version: 1, tamperV1: (b) => ({ ...b, accepts: b.accepts.map((a) => ({ ...a, network })) }) },
      { x402Versions: [1, 2] },
      { payer: () => { throw new Error("payer must not be requested"); } },
    );
    await expect(pay.fetch(url, {}, { plan })).rejects.toThrow(new RegExp(`x402 v1 network ${network} is not supported`));
    expect(server!.receivedV1).toHaveLength(0);
  });

  it("refuses a v1 network that maps fine but is not the merchant's or not allowed (base on a Sepolia merchant)", async () => {
    const { pay, plan, url } = await mock(
      { price: 10_000n, payTo: MERCHANT_PAYTO, x402Version: 1, tamperV1: (b) => ({ ...b, accepts: b.accepts.map((a) => ({ ...a, network: "base" })) }) },
      { x402Versions: [1, 2] },
    );
    await expect(pay.fetch(url, {}, { plan })).rejects.toThrow(/network eip155:8453 is not allowed/);
    expect(server!.receivedV1).toHaveLength(0);
  });

  it("never signs when a v1 merchant swaps the payee", async () => {
    const { pay, plan, url } = await mock({ price: 10_000n, payTo: MERCHANT_PAYTO, x402Version: 1, tamper: (r) => ({ ...r, payTo: ATTACKER }) }, { x402Versions: [1, 2] });
    await expect(pay.fetch(url, {}, { plan })).rejects.toThrow(/payTo 0x9999999999999999999999999999999999999999 is not the merchant's registered address/);
    expect(server!.receivedV1).toHaveLength(0);
  });

  it("refuses a payTo that rotates on every request (Browserbase-like), zero signatures", async () => {
    let n = 0;
    const rotate = (r: Parameters<NonNullable<Route["tamper"]>>[0]) => ({ ...r, payTo: `0x${(++n).toString(16).padStart(40, "a")}` });
    const { pay, plan, url } = await mock({ price: 10_000n, payTo: MERCHANT_PAYTO, x402Version: 1, tamper: rotate }, { x402Versions: [1, 2] });
    await expect(pay.fetch(url, {}, { plan })).rejects.toThrow(/is not the merchant's registered address/);
    await expect(pay.fetch(url, {}, { plan })).rejects.toThrow(/is not the merchant's registered address/);
    expect(server!.receivedV1).toHaveLength(0);
  });

  it("refuses a v1 price above the pin (maxAmountRequired is the amount)", async () => {
    const { pay, plan, url } = await mock({ price: 900_000n, payTo: MERCHANT_PAYTO, x402Version: 1 }, { x402Versions: [1, 2] });
    await expect(pay.fetch(url, {}, { plan })).rejects.toThrow(/pinned price/);
    expect(server!.receivedV1).toHaveLength(0);
  });

  it("applies maxPerTx, asset pin, EIP-712 domain pin and timeout bounds to v1 unchanged", async () => {
    const cases: [Route["tamper"], RegExp][] = [
      [(r) => ({ ...r, asset: ATTACKER }), /not the pinned USDC/],
      [(r) => ({ ...r, extra: { name: "Fake", version: "2" } }), /domain name/],
      [(r) => ({ ...r, maxTimeoutSeconds: 3600 }), /maxTimeoutSeconds 3600/],
      [(r) => ({ ...r, scheme: "upto" }), /scheme upto/],
    ];
    for (const [tamper, error] of cases) {
      const { pay, plan, url } = await mock({ price: 10_000n, payTo: MERCHANT_PAYTO, x402Version: 1, tamper }, { x402Versions: [1, 2] });
      await expect(pay.fetch(url, {}, { plan })).rejects.toThrow(error);
      expect(server!.receivedV1).toHaveLength(0);
      await server!.close();
      server = undefined;
    }
    const { pay, plan, url } = await mock({ price: 10_000n, payTo: MERCHANT_PAYTO, x402Version: 1 }, { x402Versions: [1, 2], maxPerTx: 5_000n, pricePin: undefined });
    await expect(pay.fetch(url, {}, { plan })).rejects.toThrow(/exceeds merchant cap/);
    expect(server!.receivedV1).toHaveLength(0);
  });

  it("retries a failed v1 settlement with the same X-PAYMENT only, and resends it if the resource is asked again", async () => {
    const { pay, plan, url, origin } = await mock(
      { price: 10_000n, payTo: MERCHANT_PAYTO, x402Version: 1, tamper: (r) => ({ ...r, amount: "9000" }) },
      { x402Versions: [1, 2] },
    );
    await expect(pay.fetch(url, {}, { plan })).rejects.toBeInstanceOf(PaymentBlockedError);
    await expect(pay.fetch(url, {}, { plan })).rejects.toBeInstanceOf(PaymentBlockedError);
    expect(server!.receivedV1).toHaveLength(8);
    expect(new Set(server!.receivedV1.map((p) => p.payload.signature)).size).toBe(1);
    expect(new Set(server!.receivedV1.map((p) => p.payload.authorization.nonce)).size).toBe(1);
    expect(pay.audit.entries.filter((e) => e.event.type === "payment.signed")).toHaveLength(1);
    expect(plan.remaining(origin)).toBe(91_000n);
  });

  it("confirmAuthorization works for v1 when the receipt is unusable", async () => {
    const asked: unknown[] = [];
    const { pay, plan, url } = await mock(
      { price: 10_000n, payTo: MERCHANT_PAYTO, x402Version: 1, rawReceipt: { settled: true } },
      { x402Versions: [1, 2] },
      { confirmAuthorization: async (q) => (asked.push(q), true) },
    );
    const res = await pay.fetch(url, {}, { plan });
    expect(res.status).toBe(200);
    expect(res.payment?.confirmedOnChain).toBe(true);
    expect(res.payment?.settlement.network).toBe(NETWORK);
    expect(asked[0]).toMatchObject({ network: NETWORK, asset: PINNED_USDC[NETWORK]!.asset, authorizer: payer.address });
    expect(server!.receivedV1).toHaveLength(1);
  });

  it("refuses an oversized or malformed v1 body without signing", async () => {
    const big = { price: 10_000n, payTo: MERCHANT_PAYTO, x402Version: 1 as const, tamperV1: (b: PaymentRequiredV1) => ({ ...b, error: "x".repeat(MAX_V1_BODY_BYTES) }) };
    const a = await mock(big, { x402Versions: [1, 2] });
    await expect(a.pay.fetch(a.url, {}, { plan: a.plan })).rejects.toThrow(/402 body too large/);
    expect(server!.receivedV1).toHaveLength(0);
    await server!.close();
    server = undefined;
    const b = await mock({ price: 10_000n, payTo: MERCHANT_PAYTO, x402Version: 1, tamperV1: (x) => ({ ...x, surprise: 1 }) }, { x402Versions: [1, 2] });
    await expect(b.pay.fetch(b.url, {}, { plan: b.plan })).rejects.toThrow(/invalid x402 v1 402/);
    expect(server!.receivedV1).toHaveLength(0);
  });

  it("a header-less 402 with a large non-v1 body is still reported as a missing header for a v2 merchant", async () => {
    const net = { fetch: (async () => new Response("<html>" + "x".repeat(MAX_V1_BODY_BYTES * 2) + "</html>", { status: 402 })) as unknown as typeof fetch };
    const { pay, plan } = liveClient(HEURIST_URL, {}, net);
    await expect(pay.fetch(HEURIST_URL, {}, { plan })).rejects.toThrow(/missing header/);
  });

  it("a v1 body never unlocks a merchant that did not opt in, even when malformed", async () => {
    const { pay, plan, url } = await mock({ price: 10_000n, payTo: MERCHANT_PAYTO, x402Version: 1, tamperV1: (x) => ({ ...x, surprise: 1 }) });
    await expect(pay.fetch(url, {}, { plan })).rejects.toThrow(/x402Versions: \[1, 2\]/);
  });

  it("a v2 merchant that opted into v1 still pays v2 402s with PAYMENT-SIGNATURE", async () => {
    const { pay, plan, url } = await mock({ price: 10_000n, payTo: MERCHANT_PAYTO }, { x402Versions: [1, 2] });
    expect((await pay.fetch(url, {}, { plan })).status).toBe(200);
    expect(server!.received).toHaveLength(1);
    expect(server!.receivedV1).toHaveLength(0);
  });

  it("refuses a v1 402 from an origin that is not in the registry", async () => {
    server = await startMockServer({ "/data": { price: 10_000n, payTo: MERCHANT_PAYTO, x402Version: 1 } });
    const registry = new MerchantRegistry([{ origin: "https://other.example", payTo: MERCHANT_PAYTO, network: NETWORK, maxPerTx: 1n, x402Versions: [1, 2] }]);
    const pay = createAgentPay({ registry, policy, payer: () => payer, session: safeSession });
    const plan = pay.commitPlan([{ origin: "https://other.example", maxSpend: 1n }], 60_000);
    await expect(pay.fetch(`${server.url}/data`, {}, { plan })).rejects.toThrow(/not an approved merchant/);
    expect(server.receivedV1).toHaveLength(0);
  });
});
