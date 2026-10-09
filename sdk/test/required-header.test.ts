import { describe, expect, it } from "vitest";
import { encodeHeader, MAX_HEADER_BYTES } from "../src/x402/codec.js";
import { PINNED_USDC } from "../src/policy/networks.js";
import { fakeNet, mkPay, resp } from "./audit/helpers.js";
import { ATTACKER, ORIGIN, required, requirement } from "./fixtures.js";

const url = `${ORIGIN}/data`;

describe("payment requirement header aliases", () => {
  it.each(["PAYMENT-REQUIRED", "X-PAYMENT-REQUIRED"])("pays a valid request under %s exactly once", async (header) => {
    const net = fakeNet({ onFirst: (u) => resp(402, { [header]: encodeHeader(required()) }, u) });
    const { pay, plan } = mkPay(net);
    const response = await pay.fetch(url, {}, { plan });
    expect(response.status).toBe(200);
    expect(response.payment?.settlement.success).toBe(true);
    expect(net.signed).toHaveLength(1);
    expect(plan.remaining(ORIGIN)).toBe(20_000n);
  });

  it("prefers the standard header when both are present", async () => {
    const net = fakeNet({ onFirst: (u) => resp(402, {
      "PAYMENT-REQUIRED": encodeHeader(required()),
      "X-PAYMENT-REQUIRED": encodeHeader(required([requirement({ payTo: ATTACKER })])),
    }, u) });
    const { pay, plan } = mkPay(net);
    expect((await pay.fetch(url, {}, { plan })).status).toBe(200);
    expect(net.signed).toHaveLength(1);
  });

  it("reads an Ordiscan-style alias but refuses its mismatched Base mainnet domain before signing", async () => {
    const network = "eip155:8453";
    const net = fakeNet({ onFirst: (u) => resp(402, {
      "X-PAYMENT-REQUIRED": encodeHeader(required([requirement({
        network,
        asset: PINNED_USDC[network]!.asset,
        extra: { name: "USDC", version: "2" },
      })])),
    }, u) });
    const { pay, plan } = mkPay(net, {
      merchant: { network },
      policy: { allowedNetworks: [network] },
      payer: () => { throw new Error("payer must not be requested for a domain mismatch"); },
    });
    await expect(pay.fetch(url, {}, { plan })).rejects.toMatchObject({
      message: "payment denied: EIP-712 domain name does not match the pin",
    });
    expect(net.signed).toHaveLength(0);
    expect(net.sent).toHaveLength(1);
    expect(plan.remaining(ORIGIN)).toBe(30_000n);
  });

  it.each(["", "not base64", encodeHeader({})])("does not fall back from an invalid standard header (%j)", async (header) => {
    const net = fakeNet({ onFirst: (u) => resp(402, {
      "PAYMENT-REQUIRED": header,
      "X-PAYMENT-REQUIRED": encodeHeader(required()),
    }, u) });
    const { pay, plan } = mkPay(net);
    await expect(pay.fetch(url, {}, { plan })).rejects.toThrow();
    expect(net.signed).toHaveLength(0);
    expect(plan.remaining(ORIGIN)).toBe(30_000n);
  });

  it.each([
    ["malformed", "not base64", /not base64/],
    ["oversized", "A".repeat(MAX_HEADER_BYTES + 1), /too large/],
    ["payment term outside accepts", encodeHeader({ ...required(), payTo: ATTACKER }), /invalid header/],
    ["wrong payee", encodeHeader(required([requirement({ payTo: ATTACKER })])), /registered address/],
    ["wrong domain", encodeHeader(required([requirement({ extra: { name: "untrusted domain" } })])), /domain name/],
  ] as const)("rejects alias with %s data without signing or spending", async (_label, header, error) => {
    const net = fakeNet({ onFirst: (u) => resp(402, { "X-PAYMENT-REQUIRED": header }, u) });
    const { pay, plan } = mkPay(net);
    await expect(pay.fetch(url, {}, { plan })).rejects.toThrow(error);
    expect(net.signed).toHaveLength(0);
    expect(plan.remaining(ORIGIN)).toBe(30_000n);
  });
});
