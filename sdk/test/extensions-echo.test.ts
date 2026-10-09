import { describe, expect, it } from "vitest";
import { MerchantRegistry } from "../src/policy/registry.js";
import { MERCHANT_PAYTO, NETWORK, ORIGIN } from "./fixtures.js";
import { fakeNet, mkPay, req402, resp } from "./audit/helpers.js";

// The builder-code declaration 402.com.tr sends (captured 2026-10-09), trimmed to what matters here.
const BUILDER_CODE = {
  info: { a: "bc_pa0gqlv1" },
  schema: { type: "object", properties: { a: { type: "string" }, s: { type: "array" } }, additionalProperties: false },
};
const BAZAAR = { info: { input: { type: "http", method: "GET" } } };

function with402(extensions: Record<string, unknown>) {
  return fakeNet({ onFirst: (u) => resp(402, req402(undefined, { extensions }), u) });
}

describe("extensions are echoed only when the owner lists them for that merchant", () => {
  it("by default nothing is echoed: the payload carries no extensions", async () => {
    const net = with402({ "builder-code": BUILDER_CODE, bazaar: BAZAAR });
    const { pay, plan } = mkPay(net);
    await pay.fetch(`${ORIGIN}/a`, {}, { plan });
    expect(Object.keys(net.signed[0]!).sort()).toEqual(["accepted", "payload", "x402Version"]);
  });

  it("echoExtensions: ['builder-code'] echoes that declaration verbatim and nothing else", async () => {
    const net = with402({ "builder-code": BUILDER_CODE, bazaar: BAZAAR });
    const { pay, plan } = mkPay(net, { merchant: { echoExtensions: ["builder-code"] } });
    await pay.fetch(`${ORIGIN}/a`, {}, { plan });
    expect(net.signed[0]!.extensions).toEqual({ "builder-code": BUILDER_CODE });
    const signed = pay.audit.entries.map((e) => e.event).find((e) => e.type === "payment.signed")!;
    expect(signed.echoed).toEqual(["builder-code"]);
  });

  it("builderCodes are added as info.s, owner codes first, duplicates removed (the @x402/core merge order)", async () => {
    const declared = { ...BUILDER_CODE, info: { a: "bc_pa0gqlv1", s: ["bc_theirs", "bc_mine"] } };
    const net = with402({ "builder-code": declared });
    const { pay, plan } = mkPay(net, { merchant: { echoExtensions: ["builder-code"], builderCodes: ["bc_mine"] } });
    await pay.fetch(`${ORIGIN}/a`, {}, { plan });
    expect(net.signed[0]!.extensions).toEqual({ "builder-code": { ...BUILDER_CODE, info: { a: "bc_pa0gqlv1", s: ["bc_mine", "bc_theirs"] } } });
  });

  it("builderCodes still reach a merchant that declared no builder-code extension", async () => {
    const net = with402({ bazaar: BAZAAR });
    const { pay, plan } = mkPay(net, { merchant: { echoExtensions: ["builder-code"], builderCodes: ["bc_mine"] } });
    await pay.fetch(`${ORIGIN}/a`, {}, { plan });
    expect(net.signed[0]!.extensions).toEqual({ "builder-code": { info: { s: ["bc_mine"] } } });
  });

  it("a listed key that is missing, not an object, or too large is left out and audited; the payment goes ahead", async () => {
    const big = { info: { a: "x".repeat(5000) } };
    const net = with402({ odd: "a string", big });
    const { pay, plan } = mkPay(net, { merchant: { echoExtensions: ["missing", "odd", "big"] } });
    const res = await pay.fetch(`${ORIGIN}/a`, {}, { plan });
    expect(res.status).toBe(200);
    expect(net.signed[0]!.extensions).toBeUndefined();
    const signed = pay.audit.entries.map((e) => e.event).find((e) => e.type === "payment.signed")!;
    expect(signed.notEchoed).toEqual(["missing", "odd", "big"]);
  });

  it("echoing never changes what is paid: payee and amount come from the registry and the 402's accepts", async () => {
    const net = with402({ "builder-code": { info: { a: "bc_x", payTo: "0x9999999999999999999999999999999999999999" } } });
    const { pay, plan } = mkPay(net, { merchant: { echoExtensions: ["builder-code"] } });
    await pay.fetch(`${ORIGIN}/a`, {}, { plan });
    expect(net.signed[0]!.payload.authorization.to.toLowerCase()).toBe(MERCHANT_PAYTO.toLowerCase());
  });
});

describe("registry validation of the echo options", () => {
  const base = { origin: ORIGIN, payTo: MERCHANT_PAYTO, network: NETWORK, maxPerTx: 1n };
  it.each([
    [{ echoExtensions: ["bad key!"] }, /echoExtensions/],
    [{ echoExtensions: ["a", "a"] }, /echoExtensions/],
    [{ echoExtensions: Array.from({ length: 9 }, (_, i) => `k${i}`) }, /echoExtensions/],
    [{ echoExtensions: ["builder-code"], builderCodes: ["Has-Caps"] }, /builderCodes/],
    [{ echoExtensions: ["builder-code"], builderCodes: [] }, /builderCodes/],
    [{ builderCodes: ["bc_ok"] }, /requires "builder-code"/],
  ])("rejects %j", (extra, msg) => {
    expect(() => new MerchantRegistry([{ ...base, ...extra }])).toThrow(msg);
  });
  it("accepts a valid pair", () => {
    expect(() => new MerchantRegistry([{ ...base, echoExtensions: ["builder-code"], builderCodes: ["bc_pa0gqlv1"] }])).not.toThrow();
  });
});

describe("parity with the official client on a live 402 (402.com.tr, captured 2026-10-09)", () => {
  // What 402.com.tr declared, and what @x402/core 2.28.0 + BuilderCodeClientExtension("bc_pa0gqlv1") put in the payload.
  const DECLARED = {"info": {"a": "bc_pa0gqlv1"}, "schema": {"$schema": "https://json-schema.org/draft/2020-12/schema", "type": "object", "properties": {"a": {"type": "string", "pattern": "^[a-z0-9_]{1,32}$", "description": "App builder code"}, "w": {"type": "string", "pattern": "^[a-z0-9_]{1,32}$", "description": "Wallet builder code"}, "s": {"type": "array", "items": {"type": "string", "pattern": "^[a-z0-9_]{1,32}$"}, "description": "Service builder codes"}}, "additionalProperties": false}};
  const OFFICIAL = {"info": {"a": "bc_pa0gqlv1", "s": ["bc_pa0gqlv1"]}, "schema": {"$schema": "https://json-schema.org/draft/2020-12/schema", "type": "object", "properties": {"a": {"type": "string", "pattern": "^[a-z0-9_]{1,32}$", "description": "App builder code"}, "w": {"type": "string", "pattern": "^[a-z0-9_]{1,32}$", "description": "Wallet builder code"}, "s": {"type": "array", "items": {"type": "string", "pattern": "^[a-z0-9_]{1,32}$"}, "description": "Service builder codes"}}, "additionalProperties": false}};
  it("echoExtensions ['builder-code'] + builderCodes ['bc_pa0gqlv1'] produce the same builder-code extension", async () => {
    const net = with402({ "builder-code": DECLARED });
    const { pay, plan } = mkPay(net, { merchant: { echoExtensions: ["builder-code"], builderCodes: ["bc_pa0gqlv1"] } });
    await pay.fetch(`${ORIGIN}/a`, {}, { plan });
    expect(net.signed[0]!.extensions).toEqual({ "builder-code": OFFICIAL });
  });
});
