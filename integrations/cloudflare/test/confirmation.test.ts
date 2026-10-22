import { describe, expect, it, vi } from "vitest";
import type { Merchant } from "@deepfirstsearch/agent-pay";
import { agentSafeConfirmation, type AgentSafeConfirmationOptions, type PaymentRequirements } from "../src/index.js";

const ORIGIN = "https://api.example.com";
const PAYEE = "0x1111111111111111111111111111111111111111";
const ATTACKER = "0x9999999999999999999999999999999999999999";
const USDC_BASE = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";

const MERCHANT: Merchant = { origin: ORIGIN, payTo: PAYEE, network: "eip155:8453", maxPerTx: 50_000n, pricePin: 10_000n };

const req = (over: Partial<PaymentRequirements> = {}): PaymentRequirements => ({
  scheme: "exact",
  network: "eip155:8453",
  maxAmountRequired: "10000",
  payTo: PAYEE,
  asset: USDC_BASE,
  maxTimeoutSeconds: 120,
  ...over,
});

const cb = (extra: Partial<AgentSafeConfirmationOptions> = {}) => agentSafeConfirmation({ merchant: MERCHANT, ...extra });

describe("agentSafeConfirmation", () => {
  it("approves an honest payment to the pinned payee", async () => {
    expect(await cb()([req()])).toBe(true);
  });

  it("refuses a payment to a swapped payee (nothing signed)", async () => {
    const onRefusal = vi.fn();
    expect(await cb({ onRefusal })([req({ payTo: ATTACKER })])).toBe(false);
    expect(onRefusal).toHaveBeenCalledWith(expect.objectContaining({ code: "payee_mismatch" }));
  });

  it("refuses an amount over the per-payment cap", async () => {
    expect(await cb()([req({ maxAmountRequired: "60000" })])).toBe(false);
  });

  it("refuses an amount over the price pin", async () => {
    expect(await cb()([req({ maxAmountRequired: "20000" })])).toBe(false);
  });

  it("refuses a disallowed network", async () => {
    expect(await cb()([req({ network: "eip155:1" })])).toBe(false);
  });

  it("refuses a swapped asset on the right network (the decimals trick)", async () => {
    expect(await cb()([req({ asset: "0x0000000000000000000000000000000000000bad" })])).toBe(false);
  });

  it("accepts the legacy network name 'base'", async () => {
    expect(await cb()([req({ network: "base" })])).toBe(true);
  });

  it("refuses the whole 402 if ANY option is unsafe, even mixed with a safe one", async () => {
    // The client — not the callback — chooses which option to pay, so one bad option taints the payment.
    expect(await cb()([req(), req({ payTo: ATTACKER })])).toBe(false);
  });

  it("approves a multi-option 402 when every option is safe", async () => {
    expect(await cb()([req(), req({ maxAmountRequired: "9000" })])).toBe(true);
  });

  it("enforces a session budget across payments", async () => {
    const pay = cb({ sessionBudget: 15_000n });
    expect(await pay([req()])).toBe(true); // 10,000 spent
    expect(await pay([req()])).toBe(false); // 10,000 more would exceed 15,000
    expect(await pay([req({ maxAmountRequired: "5000" })])).toBe(true); // 5,000 fits
  });

  it("refuses an empty or missing options list", async () => {
    expect(await cb()([])).toBe(false);
    expect(await cb()(undefined as unknown as PaymentRequirements[])).toBe(false);
  });

  it("throws on an invalid merchant (bad payTo or non-positive cap)", () => {
    expect(() => agentSafeConfirmation({ merchant: { ...MERCHANT, payTo: "0xnope" as `0x${string}` } })).toThrow(/payTo/);
    expect(() => agentSafeConfirmation({ merchant: { ...MERCHANT, maxPerTx: 0n } })).toThrow(/maxPerTx/);
  });
});
