import { describe, expect, it } from "vitest";
import { evaluate } from "../src/policy/engine.js";
import { MerchantRegistry } from "../src/policy/registry.js";
import { commitPlan } from "../src/guard/plan.js";
import { PaymentRequired } from "../src/x402/schemas.js";
import { createAgentPay } from "../src/x402/client.js";
import { startMockServer } from "../src/testing/index.js";
import { privateKeyToAccount } from "viem/accounts";

// 402s captured from live x402 merchants on Base mainnet (2026-10-07). Parsing them must not break.
const EXA = {
  x402Version: 2,
  resource: { url: "https://api.exa.ai/search", description: "Exa /search endpoint", mimeType: "application/json" },
  accepts: [
    { scheme: "exact", network: "eip155:8453", amount: "4000", payTo: "0x6d6E695b09861467c7d462f5AAF31cF3540B9192", maxTimeoutSeconds: 60, asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", extra: { name: "USD Coin", version: "2", breakdown: { search: 0.004 }, totalUsd: 0.004, acceptId: "legacy" } },
    { scheme: "exact", network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", amount: "4000", payTo: "12Ec2cJmfR1C9uwejzxcuMhUgEC7wDrLgm1wBvvR5w9E", maxTimeoutSeconds: 60, asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", extra: { feePayer: "BFK9TLC3edb13K6v4YyH3DwPb5DSUpkWvb7XnqCL9b4F", name: "USD Coin", version: "2" } },
    { scheme: "exact", network: "eip155:8453", amount: "4000", payTo: "0xB98eF29eb2be19Ae646A8FC0248255B90A332dbC", maxTimeoutSeconds: 604900, asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", extra: { name: "GatewayWalletBatched", version: "1", verifyingContract: "0x77777777dcc4d5a8b6e418fd04d8997ef11000ee", minValiditySeconds: 604800, assets: [{ symbol: "USDC" }] } },
  ],
};
const BLOCKRUN = {
  x402Version: 2,
  accepts: [{ scheme: "exact", network: "eip155:8453", amount: "3000", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", payTo: "0xe9030014F5DAe217d0A152f02A043567b16c1aBf", maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2" } }],
  resource: { url: "https://blockrun.ai/api/v1/exa/contents", description: "Extract full text content", mimeType: "application/json" },
  extensions: { bazaar: { schema: { type: "object" } } },
};

describe("real x402 merchants on Base", () => {
  it("parses Exa's 402 (extra fields kept) and picks the standard USDC option, not the gateway one", () => {
    const required = PaymentRequired.parse(EXA);
    expect((required.accepts[0]!.extra as Record<string, unknown>).acceptId).toBe("legacy");
    const registry = new MerchantRegistry([{ origin: "https://api.exa.ai", payTo: "0x6d6E695b09861467c7d462f5AAF31cF3540B9192", network: "eip155:8453", maxPerTx: 10_000n, pricePin: 4_000n }]);
    const plan = commitPlan(registry, [{ origin: "https://api.exa.ai", maxSpend: 20_000n }], 60_000);
    const d = evaluate({ allowedNetworks: ["eip155:8453"] }, registry, { url: "https://api.exa.ai/search", required, plan, spentInPeriod: 0n, now: Date.now() });
    expect(d.kind).toBe("allow");
    if (d.kind !== "deny") expect(d.requirement.payTo).toBe("0x6d6E695b09861467c7d462f5AAF31cF3540B9192");
  });

  it("parses BlockRun's 402 with Bazaar extensions", () => {
    const required = PaymentRequired.parse(BLOCKRUN);
    const registry = new MerchantRegistry([{ origin: "https://blockrun.ai", payTo: "0xe9030014F5DAe217d0A152f02A043567b16c1aBf", network: "eip155:8453", maxPerTx: 10_000n, pricePin: 3_000n }]);
    const plan = commitPlan(registry, [{ origin: "https://blockrun.ai", maxSpend: 20_000n }], 60_000);
    expect(evaluate({ allowedNetworks: ["eip155:8453"] }, registry, { url: "https://blockrun.ai/api/v1/exa/contents", required, plan, spentInPeriod: 0n, now: Date.now() }).kind).toBe("allow");
  });

  it("keeps EVM address checks on eip155 options", () => {
    expect(() => PaymentRequired.parse({ ...BLOCKRUN, accepts: [{ ...BLOCKRUN.accepts[0], payTo: "not-an-address" }] })).toThrow(/20-byte hex/);
  });

  it("still rejects unknown fields outside extra", () => {
    expect(() => PaymentRequired.parse({ ...BLOCKRUN, surprise: 1 })).toThrow();
    expect(() => PaymentRequired.parse({ ...BLOCKRUN, accepts: [{ ...BLOCKRUN.accepts[0], payToOverride: "0x9999999999999999999999999999999999999999" }] })).toThrow();
  });
});

describe("settlement receipts", () => {
  it("accepts a receipt under the legacy X-PAYMENT-RESPONSE header and does not report the payment as failed", async () => {
    const MERCHANT = "0x1111111111111111111111111111111111111111";
    const m = await startMockServer({ "/data": { price: 10_000n, payTo: MERCHANT, legacyReceipt: true, body: '{"ok":true}' } });
    const pay = createAgentPay({
      registry: new MerchantRegistry([{ origin: m.url, payTo: MERCHANT, network: "eip155:84532", maxPerTx: 50_000n, pricePin: 10_000n }]),
      policy: { allowedNetworks: ["eip155:84532"] },
      payer: () => privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"),
      session: { readsUntrustedInput: true, accessesSensitiveData: false, canPay: true },
      settleRetries: 2, settleRetryDelayMs: 0,
    });
    const plan = pay.commitPlan([{ origin: m.url, maxSpend: 50_000n }], 60_000);
    const r = await pay.fetch(`${m.url}/data`, {}, { plan });
    expect(r.status).toBe(200);
    expect(r.payment?.amount).toBe(10_000n);
    expect(m.received).toHaveLength(1); // no retry: the receipt was understood the first time
    await m.close();
  });
});
