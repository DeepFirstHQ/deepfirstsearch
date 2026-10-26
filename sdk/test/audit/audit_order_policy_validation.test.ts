import { describe, expect, it } from "vitest";
import { createOrderGuard, OrderRefusedError, type OrderPolicy } from "../../../integrations/order-guard/src/index.js";
import { createMockDelivery } from "../../../integrations/order-guard/src/testing.js";

const HOME = "10 Fixture Road";
const STORE = "la-taqueria";
const INPUT = { storeId: STORE, items: [{ itemId: "carnitas-burrito", quantity: 1 }], tip: 0 };

/** Real guard and repository mock backend. All orders and prices stay in memory.
 * Invalid numbers originate in owner configuration, never in model tool input.
 */
function setup(overrides: Partial<OrderPolicy> = {}) {
  let clock = 10_000;
  const backend = createMockDelivery({ address: HOME, feeRate: 0, taxRate: 0 });
  const policy: OrderPolicy = {
    stores: { [STORE]: { label: "Fixture store", maxOrderTotal: 1_500 } },
    deliveryAddress: HOME,
    maxOrderTotal: 3_000,
    maxTip: 0,
    dailyBudget: 10_000,
    approvalAbove: 2_000,
    previewMaxAgeMs: 1_000,
    ...overrides,
  };
  return { backend, policy, now: () => clock, advance(ms: number) { clock += ms; } };
}

async function attempt(t: ReturnType<typeof setup>, quantity = 1, ageMs = 0) {
  let guard: ReturnType<typeof createOrderGuard>;
  try {
    guard = createOrderGuard(t.policy, t.backend, t.now);
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    return { kind: "configuration rejected" as const };
  }
  const { preview } = await guard.preview({ ...INPUT, items: [{ itemId: "carnitas-burrito", quantity }] });
  t.advance(ageMs);
  return guard.submit(preview.previewId).then(
    (result) => ({ kind: "submitted" as const, result, spent: guard.spentToday() }),
    (error: unknown) => {
      if (!(error instanceof OrderRefusedError)) throw error;
      return { kind: "refused" as const, error };
    },
  );
}

describe("order guard contains invalid optional numeric configuration", () => {
  it("submits an affordable order under valid finite limits", async () => {
    const t = setup();
    expect(await attempt(t)).toMatchObject({ kind: "submitted", result: { total: 1_250 }, spent: 1_250 });
    expect(t.backend.orders).toHaveLength(1);
  });

  it("enforces a valid lower store cap", async () => {
    const t = setup();
    const result = await attempt(t, 2);
    expect(result.kind).toBe("refused");
    if (result.kind === "refused") expect(result.error.message).toContain("above the $15.00 cap");
    expect(t.backend.orders).toHaveLength(0);
  });

  it("requires approval above a finite threshold when no approver is configured", async () => {
    const t = setup({ approvalAbove: 1_000 });
    const result = await attempt(t);
    expect(result.kind).toBe("refused");
    if (result.kind === "refused") expect(result.error.message).toContain("owner's approval");
    expect(t.backend.orders).toHaveLength(0);
  });

  it("enforces a finite preview lifetime", async () => {
    const t = setup();
    const result = await attempt(t, 1, 1_001);
    expect(result.kind).toBe("refused");
    if (result.kind === "refused") expect(result.error.message).toContain("preview expired");
    expect(t.backend.orders).toHaveLength(0);
  });

  it("already rejects a NaN global order cap during construction", () => {
    const t = setup({ maxOrderTotal: Number.NaN });
    expect(() => createOrderGuard(t.policy, t.backend, t.now)).toThrow(/maxOrderTotal/);
    expect(t.backend.orders).toHaveLength(0);
  });

  it("does not disable a valid global cap when a store cap is NaN", async () => {
    const t = setup({
      maxOrderTotal: 1_500,
      stores: { [STORE]: { label: "Fixture store", maxOrderTotal: Number.NaN } },
      approvalAbove: undefined,
    });
    const result = await attempt(t, 2);
    expect.soft(result.kind).not.toBe("submitted");
    expect.soft(t.backend.orders).toHaveLength(0);
    expect.soft(t.backend.orders.reduce((sum, order) => sum + order.preview.total, 0)).toBeLessThanOrEqual(1_500);
  });

  it("rejects or refuses a NaN approval threshold rather than submitting without an approver", async () => {
    const t = setup({ approvalAbove: Number.NaN });
    const result = await attempt(t);
    expect.soft(result.kind).not.toBe("submitted");
    expect.soft(t.backend.orders).toHaveLength(0);
  });

  it("rejects or refuses a NaN preview lifetime rather than accepting an old preview", async () => {
    const t = setup({ previewMaxAgeMs: Number.NaN });
    const result = await attempt(t, 1, 1_001);
    expect.soft(result.kind).not.toBe("submitted");
    expect.soft(t.backend.orders).toHaveLength(0);
  });
});
