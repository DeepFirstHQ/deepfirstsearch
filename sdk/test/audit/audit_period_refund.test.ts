import { describe, expect, it } from "vitest";
import { commitPlan } from "../../src/guard/plan.js";
import { PINNED_USDC } from "../../src/policy/networks.js";
import { MerchantRegistry } from "../../src/policy/registry.js";
import { agentSafeGuard, type HookableX402Client } from "../../src/x402/officialClient.js";

const ORIGIN = "https://period-refund.invalid";
const NETWORK = "eip155:84532";
const PAYEE = "0x1111111111111111111111111111111111111111";
const ASSET = PINNED_USDC[NETWORK]!;
const PERIOD_CAP = 1_000n;
const PERIOD_MS = 1_000;

/** Exercises the real guard, policy engine and plan at the documented client-hook boundary.
 * The client double only captures callbacks: no HTTP, RPC, wallet or signatures are used.
 */
function setup() {
  let clock = 10_000;
  const registry = new MerchantRegistry([
    { origin: ORIGIN, payTo: PAYEE, network: NETWORK, maxPerTx: PERIOD_CAP },
  ]);
  const plan = commitPlan(registry, [{ origin: ORIGIN, maxSpend: 5_000n }], 60_000, clock);
  let before!: Parameters<HookableX402Client["onBeforePaymentCreation"]>[0];
  let creationFailure!: Parameters<HookableX402Client["onPaymentCreationFailure"]>[0];
  let response!: Parameters<HookableX402Client["onPaymentResponse"]>[0];
  const client: HookableX402Client = {
    onBeforePaymentCreation(hook) { before = hook; },
    onPaymentCreationFailure(hook) { creationFailure = hook; },
    onPaymentResponse(hook) { response = hook; },
  };
  agentSafeGuard({
    registry,
    plan,
    origin: ORIGIN,
    now: () => clock,
    policy: { allowedNetworks: [NETWORK], periodBudget: { amount: PERIOD_CAP, periodMs: PERIOD_MS } },
  }).install(client);

  const requirements = (amount: bigint) => ({
    scheme: "exact",
    network: NETWORK,
    asset: ASSET.asset,
    payTo: PAYEE,
    amount: amount.toString(),
    maxTimeoutSeconds: 60,
    extra: { name: ASSET.domain.name, version: ASSET.domain.version, assetTransferMethod: "eip3009" },
  });
  return {
    plan,
    nextPeriod() { clock += PERIOD_MS + 1; },
    reserve(amount: bigint) {
      return before({ paymentRequired: { x402Version: 2 }, selectedRequirements: requirements(amount) });
    },
    failCreation(amount: bigint) {
      return creationFailure({ selectedRequirements: requirements(amount), error: new Error("test signing failure") });
    },
    settle(amount: bigint) {
      return response({ requirements: requirements(amount), settleResponse: { success: true } });
    },
  };
}

const budgetExhausted = { abort: true, reason: expect.stringContaining("budget_exhausted") };

describe("agentSafeGuard period accounting for released reservations", () => {
  it("returns capacity when an unsigned reservation fails in the same period", async () => {
    const t = setup();
    expect(await t.reserve(PERIOD_CAP)).toBeUndefined();
    expect(await t.reserve(1n)).toMatchObject(budgetExhausted);
    await t.failCreation(PERIOD_CAP);
    expect(t.plan.remaining(ORIGIN)).toBe(5_000n);
    expect(await t.reserve(PERIOD_CAP)).toBeUndefined();
  });

  it("keeps the new period exhausted while an older reservation is still pending", async () => {
    const t = setup();
    expect(await t.reserve(200n)).toBeUndefined();
    t.nextPeriod();
    expect(await t.reserve(PERIOD_CAP)).toBeUndefined();
    await t.settle(PERIOD_CAP);
    expect(await t.reserve(200n)).toMatchObject(budgetExhausted);
  });

  it("does not erase current-period spend when a previous-period reservation fails", async () => {
    const t = setup();
    expect(await t.reserve(200n)).toBeUndefined();
    t.nextPeriod();
    expect(await t.reserve(PERIOD_CAP)).toBeUndefined();
    await t.settle(PERIOD_CAP);
    await t.failCreation(200n);

    // Only the old reservation is returned to the session plan. The new period has
    // already spent its entire cap and must still refuse any additional reservation.
    expect(t.plan.remaining(ORIGIN)).toBe(4_000n);
    expect(await t.reserve(200n)).toMatchObject(budgetExhausted);
  });
});
