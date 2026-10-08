import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { decodeHeader, encodeHeader, MAX_HEADER_BYTES, X402DecodeError } from "../src/x402/codec.js";
import { PaymentRequired, SettleResponse } from "../src/x402/schemas.js";

// Property tests for the x402 header decoder (issue #10): whatever a server sends, decoding either returns a value
// that satisfies the schema or throws X402DecodeError. Nothing else escapes, nothing oversized is parsed.

const hexAddr = fc.uint8Array({ minLength: 20, maxLength: 20 }).map((b) => `0x${Buffer.from(b).toString("hex")}`);
const atomic = fc.bigInt({ min: 1n, max: 10n ** 30n }).map(String);
const option = fc.record({
  scheme: fc.constant("exact"),
  network: fc.constantFrom("eip155:8453", "eip155:84532"),
  amount: atomic,
  asset: hexAddr,
  payTo: hexAddr,
  maxTimeoutSeconds: fc.integer({ min: 0, max: 86_400 }),
  extra: fc.option(fc.record({ name: fc.constant("USD Coin"), version: fc.constant("2") }), { nil: undefined }),
});
const required = fc.record({
  x402Version: fc.constant(2),
  resource: fc.option(fc.record({ url: fc.webUrl(), description: fc.string({ maxLength: 50 }) }), { nil: undefined }),
  accepts: fc.array(option, { minLength: 1, maxLength: 4 }),
});

const decodesOrRejects = (raw: string | null) => {
  try {
    const v = decodeHeader(raw, PaymentRequired);
    expect(PaymentRequired.safeParse(v).success).toBe(true);
  } catch (e) {
    expect(e).toBeInstanceOf(X402DecodeError);
  }
};

describe("x402 header decoder (property tests)", () => {
  it("never throws anything but X402DecodeError on arbitrary strings", () => {
    fc.assert(fc.property(fc.string({ maxLength: 2000 }), decodesOrRejects), { numRuns: 500 });
  });

  it("never throws anything but X402DecodeError on arbitrary base64 of arbitrary bytes", () => {
    fc.assert(fc.property(fc.uint8Array({ maxLength: 3000 }), (b) => decodesOrRejects(Buffer.from(b).toString("base64"))), { numRuns: 500 });
  });

  it("never throws anything but X402DecodeError on arbitrary JSON", () => {
    fc.assert(fc.property(fc.jsonValue({ maxDepth: 4 }), (j) => decodesOrRejects(encodeHeader(j))), { numRuns: 500 });
  });

  it("refuses anything above the size cap before parsing it", () => {
    fc.assert(
      fc.property(fc.integer({ min: MAX_HEADER_BYTES + 1, max: MAX_HEADER_BYTES * 4 }), (n) => {
        expect(() => decodeHeader("A".repeat(n), PaymentRequired)).toThrow(/too large/);
      }),
      { numRuns: 50 },
    );
  });

  it("round-trips every valid 402", () => {
    fc.assert(
      fc.property(required, (r) => {
        expect(decodeHeader(encodeHeader(r), PaymentRequired)).toEqual(JSON.parse(JSON.stringify(r)));
      }),
      { numRuns: 300 },
    );
  });

  it("rejects a valid 402 with any unknown top-level key or option key", () => {
    const reserved = new Set(["x402Version", "error", "resource", "accepts", "extensions", "scheme", "network", "amount", "asset", "payTo", "maxTimeoutSeconds", "extra", "currency", "maxAmountRequired", "recipient", "description", "mimeType"]);
    const key = fc.string({ minLength: 1, maxLength: 20 }).filter((k) => !reserved.has(k) && k !== "__proto__");
    fc.assert(
      fc.property(required, key, fc.jsonValue({ maxDepth: 2 }), fc.boolean(), (r, k, v, top) => {
        const bad = top ? { ...r, [k]: v } : { ...r, accepts: [{ ...r.accepts[0], [k]: v }, ...r.accepts.slice(1)] };
        expect(() => decodeHeader(encodeHeader(bad), PaymentRequired)).toThrow(X402DecodeError);
      }),
      { numRuns: 300 },
    );
  });

  it("rejects an eip155 option whose payTo or asset is not a 20-byte hex address", () => {
    const notAddr = fc.string({ maxLength: 60 }).filter((s) => !/^0x[0-9a-fA-F]{40}$/.test(s) && s.length > 0);
    fc.assert(
      fc.property(required, notAddr, fc.constantFrom("payTo", "asset"), (r, s, field) => {
        const bad = { ...r, accepts: [{ ...r.accepts[0], [field]: s }] };
        expect(() => decodeHeader(encodeHeader(bad), PaymentRequired)).toThrow(X402DecodeError);
      }),
      { numRuns: 300 },
    );
  });

  it("accepts v1 aliases only when they agree with the v2 fields", () => {
    fc.assert(
      fc.property(required, hexAddr, atomic, (r, other, otherAmount) => {
        const o = r.accepts[0]!;
        const agree = { ...r, accepts: [{ ...o, recipient: o.payTo.toUpperCase().replace("0X", "0x"), currency: o.asset, maxAmountRequired: o.amount }] };
        expect(() => decodeHeader(encodeHeader(agree), PaymentRequired)).not.toThrow();
        fc.pre(other.toLowerCase() !== o.payTo.toLowerCase() && otherAmount !== o.amount);
        expect(() => decodeHeader(encodeHeader({ ...r, accepts: [{ ...o, recipient: other }] }), PaymentRequired)).toThrow(X402DecodeError);
        expect(() => decodeHeader(encodeHeader({ ...r, accepts: [{ ...o, maxAmountRequired: otherAmount }] }), PaymentRequired)).toThrow(X402DecodeError);
      }),
      { numRuns: 200 },
    );
  });

  it("parses settlement receipts leniently but never invents success", () => {
    fc.assert(
      fc.property(fc.jsonValue({ maxDepth: 3 }), (j) => {
        try {
          const s = decodeHeader(encodeHeader(j), SettleResponse);
          expect(typeof s.success).toBe("boolean");
          expect((j as { success?: unknown }).success).toBe(s.success);
        } catch (e) {
          expect(e).toBeInstanceOf(X402DecodeError);
        }
      }),
      { numRuns: 500 },
    );
  });
});
