import { describe, expect, it } from "vitest";
import { getAddress } from "viem";
import { evaluate } from "../../src/policy/engine.js";
import { decodeHeader, encodeHeader, MAX_HEADER_BYTES } from "../../src/x402/codec.js";
import { PaymentRequired, SettleResponse } from "../../src/x402/schemas.js";
import { ATTACKER, MERCHANT_PAYTO, ORIGIN, USDC, merchant, policy, required, requirement, setup } from "../fixtures.js";
import { fakeNet, mkPay, ok, resp } from "./helpers.js";

const URL_ = `${ORIGIN}/data`;
function ev(accepts = [requirement()], cfg = policy, m = merchant()) {
  const { registry, plan } = setup(m);
  return evaluate(cfg, registry, { url: URL_, required: required(accepts), plan, spentInPeriod: 0n, now: Date.now() });
}
function parse(obj: unknown) {
  return decodeHeader(Buffer.from(JSON.stringify(obj)).toString("base64"), PaymentRequired);
}

describe("regression: amount encodings", () => {
  for (const bad of ["1e6", "0x10", "-1", "10.5", " 10000", "10000 ", "١٠٠٠٠", "+10000", "", "1".repeat(79)]) {
    it(`rejects amount ${JSON.stringify(bad).slice(0, 20)} at the schema`, () => {
      expect(() => parse({ x402Version: 2, accepts: [requirement({ amount: bad })] })).toThrow();
    });
  }
  it("rejects a numeric (non-string) amount", () => {
    expect(() => parse({ x402Version: 2, accepts: [{ ...requirement(), amount: 10000 }] })).toThrow();
  });
  it("leading zeros parse to the same value and stay within caps", () => {
    const d = ev([requirement({ amount: "0000000000010000" })]);
    expect(d.kind).toBe("allow");
    expect(d.kind !== "deny" && d.amount).toBe(10_000n);
  });
  it("78-digit (> 2^256) amounts are denied by the caps, not wrapped", () => {
    const d = ev([requirement({ amount: "9".repeat(78) })]);
    expect(d.kind).toBe("deny");
  });
  it("zero is denied", () => {
    expect(ev([requirement({ amount: "0" })]).kind).toBe("deny");
  });
});

describe("regression: payee / asset / network / scheme confusion", () => {
  it("lowercase and bad-checksum spellings of the registered payTo are the same address (accepted)", () => {
    expect(ev([requirement({ payTo: MERCHANT_PAYTO.toLowerCase() as never })]).kind).toBe("allow");
    const payTo = "0xAb5801a7D398351b8bE11C439e05C5B3259aeC9B" as const;
    const badChecksum = "0xAB5801a7d398351b8be11c439e05c5b3259aec9b" as never;
    expect(ev([requirement({ payTo: badChecksum })], policy, merchant({ payTo })).kind).toBe("allow");
  });
  it("a different payTo is denied whatever its case", () => {
    expect(ev([requirement({ payTo: ATTACKER })]).kind).toBe("deny");
  });
  it("mixed-case asset with wrong checksum still compared by value; other assets denied", () => {
    const flipped = ("0x" + USDC.asset.slice(2).split("").map((c, i) => (i % 2 ? c.toUpperCase() : c.toLowerCase())).join("")) as never;
    expect(ev([requirement({ asset: flipped })]).kind).toBe("allow");
    expect(ev([requirement({ asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" })]).kind).toBe("deny"); // mainnet USDC on sepolia
  });
  it("network must be allowed AND equal the merchant's network", () => {
    expect(ev([requirement({ network: "eip155:8453" })], { ...policy, allowedNetworks: ["eip155:84532", "eip155:8453"] }).kind).toBe("deny");
    expect(() => parse({ x402Version: 2, accepts: [requirement({ network: "EIP155:84532" })] })).toThrow();
  });
  it("scheme must be exactly 'exact'", () => {
    for (const s of ["Exact", "exact ", "upto"]) expect(ev([requirement({ scheme: s })]).kind).toBe("deny");
  });
  it("prototype keys as network do not resolve a pinned asset", () => {
    expect(() => parse({ x402Version: 2, accepts: [requirement({ network: "__proto__" })] })).toThrow();
    expect(ev([requirement({ network: "eip155:1" })], { ...policy, allowedNetworks: ["eip155:1"] }, merchant({ network: "eip155:1" })).kind).toBe("deny");
  });
  it("among several accepts, a bad entry never wins and the cheapest valid one is paid", () => {
    const d = ev([
      requirement({ payTo: ATTACKER, amount: "1" }),
      requirement({ amount: "11000" }),
      requirement({ amount: "10000" }),
    ]);
    expect(d.kind).toBe("allow");
    expect(d.kind !== "deny" && [d.amount, getAddress(d.requirement.payTo)]).toEqual([10_000n, MERCHANT_PAYTO]);
  });
  it("more than 16 accepts are rejected", () => {
    expect(() => parse({ x402Version: 2, accepts: Array.from({ length: 17 }, () => requirement()) })).toThrow();
  });
});

describe("regression: EIP-712 domain cannot be chosen by the server", () => {
  it("denies extra.name / extra.version that differ from the pin", () => {
    expect(ev([requirement({ extra: { name: "USD Coin" } })]).kind).toBe("deny");
    expect(ev([requirement({ extra: { version: "1" } })]).kind).toBe("deny");
    expect(ev([requirement({ extra: { assetTransferMethod: "permit2" } })]).kind).toBe("deny");
  });
  it("ignores domain fields a server puts in extra (chainId, verifyingContract): the signature uses the pinned domain", async () => {
    // `extra` is free-form in the spec (real merchants add pricing breakdowns), so these keys parse, but nothing in
    // them reaches the signature: the EIP-712 domain always comes from the pinned asset.
    const { verifyTypedData } = await import("viem");
    const { TRANSFER_WITH_AUTHORIZATION_TYPES, usdcDomain } = await import("../../src/x402/exactEvm.js");
    const hostile = requirement({ extra: { name: USDC.domain.name, version: USDC.domain.version, chainId: 1, verifyingContract: ATTACKER } as never });
    expect(() => parse({ x402Version: 2, accepts: [hostile] })).not.toThrow();
    const net = fakeNet({ onFirst: (u) => resp(402, { "PAYMENT-REQUIRED": encodeHeader(required([hostile])) }, u) });
    const { pay, plan } = mkPay(net);
    await pay.fetch(URL_, {}, { plan });
    const { authorization: a, signature } = net.signed[0]!.payload;
    const msg = { from: a.from as never, to: a.to as never, value: BigInt(a.value), validAfter: BigInt(a.validAfter), validBefore: BigInt(a.validBefore), nonce: a.nonce as never };
    const onPinned = await verifyTypedData({ address: a.from as never, domain: usdcDomain(USDC), types: TRANSFER_WITH_AUTHORIZATION_TYPES, primaryType: "TransferWithAuthorization", message: msg, signature: signature as never });
    const onHostile = await verifyTypedData({ address: a.from as never, domain: { ...usdcDomain(USDC), chainId: 1, verifyingContract: ATTACKER }, types: TRANSFER_WITH_AUTHORIZATION_TYPES, primaryType: "TransferWithAuthorization", message: msg, signature: signature as never });
    expect(onPinned).toBe(true);
    expect(onHostile).toBe(false);
  });
  it("signs with the pinned domain even when extra is absent", async () => {
    const { verifyTypedData } = await import("viem");
    const { TRANSFER_WITH_AUTHORIZATION_TYPES, usdcDomain } = await import("../../src/x402/exactEvm.js");
    const net = fakeNet({ onFirst: (u) => resp(402, { "PAYMENT-REQUIRED": encodeHeader(required([requirement({ extra: undefined })])) }, u) });
    const { pay, plan } = mkPay(net);
    await pay.fetch(URL_, {}, { plan });
    const { authorization: a, signature } = net.signed[0]!.payload;
    const valid = await verifyTypedData({
      address: a.from as never,
      domain: usdcDomain(USDC),
      types: TRANSFER_WITH_AUTHORIZATION_TYPES,
      primaryType: "TransferWithAuthorization",
      message: { from: a.from as never, to: a.to as never, value: BigInt(a.value), validAfter: BigInt(a.validAfter), validBefore: BigInt(a.validBefore), nonce: a.nonce as never },
      signature: signature as never,
    });
    expect(valid).toBe(true);
    expect(a.to).toBe(MERCHANT_PAYTO);
  });
});

describe("regression: maxTimeoutSeconds", () => {
  it("rejects out-of-bounds, fractional and negative timeouts", () => {
    expect(ev([requirement({ maxTimeoutSeconds: 301 })]).kind).toBe("deny");
    expect(ev([requirement({ maxTimeoutSeconds: 9 })]).kind).toBe("deny");
    expect(() => parse({ x402Version: 2, accepts: [requirement({ maxTimeoutSeconds: 1.5 })] })).toThrow();
    expect(() => parse({ x402Version: 2, accepts: [requirement({ maxTimeoutSeconds: -1 })] })).toThrow();
    expect(() => parse({ x402Version: 2, accepts: [{ ...requirement(), maxTimeoutSeconds: 1e300 }] })).toThrow();
  });
  it("validBefore is never more than the bound past now; nonces are unique", async () => {
    const net = fakeNet({ onFirst: (u) => resp(402, { "PAYMENT-REQUIRED": encodeHeader(required([requirement({ maxTimeoutSeconds: 300 })])) }, u) });
    const t = 1_800_000_000_000;
    const { pay } = mkPay(net, { now: () => t });
    const plan = pay.commitPlan([{ origin: ORIGIN, maxSpend: 30_000n }], 60_000);
    await pay.fetch(URL_, {}, { plan });
    await pay.fetch(URL_, {}, { plan });
    const [a, b] = net.signed.map((s) => s.payload.authorization);
    expect(BigInt(a!.validBefore) - BigInt(t / 1000)).toBe(300n);
    expect(BigInt(a!.validAfter)).toBe(BigInt(t / 1000) - 30n);
    expect(a!.nonce).not.toBe(b!.nonce);
  });
});

describe("regression: header decoding", () => {
  it("rejects v1, missing, oversized, non-base64 and non-JSON headers", () => {
    expect(ev([requirement()]).kind).toBe("allow");
    const { registry, plan } = setup();
    expect(evaluate(policy, registry, { url: URL_, required: required([requirement()], 1), plan, spentInPeriod: 0n, now: Date.now() }).kind).toBe("deny");
    expect(() => decodeHeader(null, PaymentRequired)).toThrow();
    expect(() => decodeHeader("A".repeat(MAX_HEADER_BYTES + 1), PaymentRequired)).toThrow(/too large/);
    expect(() => decodeHeader("eyJ4Ij ox", PaymentRequired)).toThrow(/base64/);
    expect(() => decodeHeader(Buffer.from("not json").toString("base64"), PaymentRequired)).toThrow();
  });
  it("rejects unknown top-level and requirement fields (strict)", () => {
    expect(() => parse({ x402Version: 2, accepts: [requirement()], payTo: ATTACKER })).toThrow();
    expect(() => parse({ x402Version: 2, accepts: [{ ...requirement(), to: ATTACKER }] })).toThrow();
  });
  it("a __proto__ key does not smuggle fields past the strict schema", () => {
    const raw = `{"x402Version":2,"accepts":[${JSON.stringify(requirement()).slice(0, -1)},"__proto__":{"payTo":"${ATTACKER}"}}]}`;
    expect(() => decodeHeader(Buffer.from(raw).toString("base64"), PaymentRequired)).toThrow(/__proto__/);
    const ext = decodeHeader(Buffer.from(`{"x402Version":2,"accepts":[],"extensions":{"__proto__":{"polluted":1}}}`).toString("base64"), PaymentRequired);
    expect((ext.extensions as Record<string, unknown>).polluted).toBeUndefined();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
  it("duplicate JSON keys: the last one wins, and it is still policy-checked", () => {
    const raw = `{"x402Version":2,"accepts":[${JSON.stringify(requirement()).slice(0, -1)},"payTo":"${ATTACKER}"}]}`;
    const r = decodeHeader(Buffer.from(raw).toString("base64"), PaymentRequired);
    const { registry, plan } = setup();
    expect(evaluate(policy, registry, { url: URL_, required: r, plan, spentInPeriod: 0n, now: Date.now() }).kind).toBe("deny");
  });
  it("two PAYMENT-REQUIRED headers (joined with ', ') are rejected", async () => {
    const h = new Headers();
    h.append("PAYMENT-REQUIRED", encodeHeader(required()));
    h.append("PAYMENT-REQUIRED", encodeHeader(required([requirement({ payTo: ATTACKER })])));
    expect(() => decodeHeader(h.get("PAYMENT-REQUIRED"), PaymentRequired)).toThrow();
  });
  it("SettleResponse is lenient but typed", () => {
    expect(decodeHeader(ok({}), SettleResponse).success).toBe(true);
  });
});
