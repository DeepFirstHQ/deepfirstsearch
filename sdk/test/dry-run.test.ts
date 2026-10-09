import { describe, expect, it } from "vitest";
import { commitPlan } from "../src/guard/plan.js";
import { MerchantRegistry } from "../src/policy/registry.js";
import { dryRun } from "../src/x402/dryRun.js";
import { encodeHeader } from "../src/x402/codec.js";
import { HEURIST_402, HEURIST_URL } from "./fixtures-v1.js";
import { ATTACKER, MERCHANT_PAYTO, NETWORK, ORIGIN, merchant, policy, required, requirement } from "./fixtures.js";

const registry = new MerchantRegistry([merchant()]);
const plan = commitPlan(registry, [{ origin: ORIGIN, maxSpend: 1_000_000n }], 3_600_000);
const ctx = { url: `${ORIGIN}/data`, policy, registry, plan };
const res = (status: number, headers: Record<string, string> = {}, body = "") => new Response(body || null, { status, headers });

describe("dryRun: the decision layer alone, every outcome a value", () => {
  it("a seller that shows no terms (200, 404) is no_challenge, not an exception", async () => {
    expect(await dryRun(res(200), ctx)).toMatchObject({ kind: "no_challenge", status: 200 });
    expect(await dryRun(res(404), ctx)).toMatchObject({ kind: "no_challenge", status: 404 });
  });

  it("a 402 with neither a header nor a v1 body is no_challenge", async () => {
    expect(await dryRun(res(402, {}, '{"error":"pay me"}'), ctx)).toMatchObject({ kind: "no_challenge", status: 402 });
    expect(await dryRun(res(402, {}, "not json"), ctx)).toMatchObject({ kind: "no_challenge", status: 402 });
  });

  it("an unreadable PAYMENT-REQUIRED is invalid_402", async () => {
    expect(await dryRun(res(402, { "PAYMENT-REQUIRED": "%%%" }), ctx)).toMatchObject({ kind: "invalid_402" });
  });

  it("a valid 402 from a registered merchant is the policy's decision", async () => {
    const v = await dryRun(res(402, { "PAYMENT-REQUIRED": encodeHeader(required()) }), ctx);
    expect(v).toMatchObject({ kind: "allow", status: 402, version: 2, amount: 10_000n });
  });

  it("a wrong payee or an unregistered origin is a deny with its code", async () => {
    const wrong = await dryRun(res(402, { "PAYMENT-REQUIRED": encodeHeader(required([requirement({ payTo: ATTACKER })])) }), ctx);
    expect(wrong).toMatchObject({ kind: "deny", codes: ["payee_mismatch"] });
    const other = await dryRun(res(402, { "PAYMENT-REQUIRED": encodeHeader(required()) }), { ...ctx, url: "https://elsewhere.example/x" });
    expect(other).toMatchObject({ kind: "deny", codes: ["unknown_merchant"] });
  });

  it("a non-https URL is a deny, not a throw", async () => {
    const v = await dryRun(res(402, { "PAYMENT-REQUIRED": encodeHeader(required()) }), { ...ctx, url: "http://plain.example/x" });
    expect(v).toMatchObject({ kind: "deny", codes: ["unknown_merchant"] });
  });

  it("an x402 v1 body is read, and refused unless the merchant opted in", async () => {
    const heurist = { origin: new URL(HEURIST_URL).origin, payTo: "0xA112c9C8BF655c678c768B6fD42a1C6FbfeD7D60" as const, network: "eip155:8453", maxPerTx: 5_000n };
    const base = { ...policy, allowedNetworks: ["eip155:8453"] };
    for (const [versions, expected] of [[undefined, "deny"], [[1, 2] as const, "allow"]] as const) {
      const reg = new MerchantRegistry([{ ...heurist, ...(versions ? { x402Versions: versions } : {}) }]);
      const p = commitPlan(reg, [{ origin: heurist.origin, maxSpend: 10_000n }], 3_600_000);
      const v = await dryRun(res(402, { "content-type": "application/json" }, HEURIST_402), { url: HEURIST_URL, policy: base, registry: reg, plan: p });
      expect(v).toMatchObject({ kind: expected, version: 1 });
    }
  });

  it("never needs a key: the payTo it reports is the registry's", async () => {
    const v = await dryRun(res(402, { "PAYMENT-REQUIRED": encodeHeader(required()) }), ctx);
    expect(v.kind === "allow" && v.merchant.payTo.toLowerCase()).toBe(MERCHANT_PAYTO.toLowerCase());
    expect(NETWORK).toBe("eip155:84532");
  });
});
