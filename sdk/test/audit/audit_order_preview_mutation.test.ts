import { describe, expect, it, vi } from "vitest";
import { createOrderGuard, OrderRefusedError } from "../../../integrations/order-guard/src/index.js";
import { createMockDelivery } from "../../../integrations/order-guard/src/testing.js";

const HOME = "10 Fixture Road";
const OTHER = "20 Other Fixture Road";
const CAP = 1_500;
const INPUT = { storeId: "la-taqueria", items: [{ itemId: "carnitas-burrito", quantity: 1 }], tip: 0 };
const LARGE = { ...INPUT, items: [{ itemId: "carnitas-burrito", quantity: 2 }] };

/** Real guard plus the repository's in-memory ordering backend. The backend
 * retains its original preview independently of the guard's top-level copy.
 * No HTTP, account, real order or payment is involved.
 */
function setup() {
  let clock = 10_000;
  const backend = createMockDelivery({ address: HOME, feeRate: 0, taxRate: 0 });
  const approve = vi.fn(async () => true);
  const guard = createOrderGuard({
    stores: { "la-taqueria": { label: "Fixture store" } },
    deliveryAddress: HOME,
    maxOrderTotal: CAP,
    maxTip: 0,
    dailyBudget: 2_000,
    approvalAbove: 1_800,
    approve,
    previewMaxAgeMs: 1_000,
  }, backend, () => clock);
  return { backend, guard, approve, advance(ms: number) { clock += ms; }, now: () => clock };
}

async function outcome(guard: ReturnType<typeof setup>["guard"], id: string) {
  return guard.submit(id).then(
    (value) => ({ kind: "submitted" as const, value }),
    (error: unknown) => ({ kind: "refused" as const, error }),
  );
}

function expectRefused(result: Awaited<ReturnType<typeof outcome>>) {
  expect.soft(result.kind).toBe("refused");
  if (result.kind === "refused") expect(result.error).toBeInstanceOf(OrderRefusedError);
}

describe("order guard keeps its checked preview independent of API consumers", () => {
  it("submits an unchanged affordable preview with matching backend and budget totals", async () => {
    const t = setup();
    const { preview, wouldBeRefusedFor } = await t.guard.preview(INPUT);
    expect(wouldBeRefusedFor).toEqual([]);
    const result = await t.guard.submit(preview.previewId);
    expect(result.total).toBe(1_250);
    expect(t.backend.orders).toHaveLength(1);
    expect(t.backend.orders[0]!.preview.total).toBe(result.total);
    expect(t.guard.spentToday()).toBe(result.total);
  });

  it("refuses an unchanged over-cap preview before approval or backend submission", async () => {
    const t = setup();
    const { preview, wouldBeRefusedFor } = await t.guard.preview(LARGE);
    expect(preview.total).toBe(2_500);
    expect(wouldBeRefusedFor.length).toBeGreaterThan(0);
    expectRefused(await outcome(t.guard, preview.previewId));
    expect(t.backend.orders).toHaveLength(0);
    expect(t.approve).not.toHaveBeenCalled();
    expect(t.guard.spentToday()).toBe(0);
  });

  it("editing a JSON copy does not change the guard's authoritative preview", async () => {
    const t = setup();
    const { preview } = await t.guard.preview(LARGE);
    const copy = JSON.parse(JSON.stringify(preview)) as typeof preview;
    copy.subtotal = copy.total = 1_000;
    expect(preview.total).toBe(2_500);
    expectRefused(await outcome(t.guard, copy.previewId));
    expect(t.backend.orders).toHaveLength(0);
    expect(t.guard.spentToday()).toBe(0);
  });

  it("refuses the backend's over-cap order after the returned preview's totals are lowered", async () => {
    const t = setup();
    const { preview } = await t.guard.preview(LARGE);
    expect(preview.total).toBe(2_500);
    preview.subtotal = preview.total = 1_000;
    expectRefused(await outcome(t.guard, preview.previewId));
    expect.soft(t.backend.orders).toHaveLength(0);
    const backendTotal = t.backend.orders.reduce((sum, order) => sum + order.preview.total, 0);
    expect.soft(backendTotal).toBeLessThanOrEqual(CAP);
    expect.soft(t.guard.spentToday()).toBe(backendTotal);
    expect(t.approve).not.toHaveBeenCalled();
  });

  it("refuses a backend order to another address after only the returned address is replaced", async () => {
    const t = setup();
    t.backend.setDeliveryAddress(OTHER);
    const { preview, wouldBeRefusedFor } = await t.guard.preview(INPUT);
    expect(wouldBeRefusedFor).toContain("delivery address is not the owner's address");
    preview.deliveryAddress = HOME;
    expectRefused(await outcome(t.guard, preview.previewId));
    expect.soft(t.backend.orders).toHaveLength(0);
    expect.soft(t.backend.orders.every((order) => order.preview.deliveryAddress === HOME)).toBe(true);
    expect.soft(t.guard.spentToday()).toBe(0);
  });

  it("refuses an expired preview after the caller refreshes only the returned timestamp", async () => {
    const t = setup();
    const { preview } = await t.guard.preview(INPUT);
    t.advance(1_001);
    preview.checkedAt = t.now();
    expectRefused(await outcome(t.guard, preview.previewId));
    expect.soft(t.backend.orders).toHaveLength(0);
    expect.soft(t.guard.spentToday()).toBe(0);
  });
});
