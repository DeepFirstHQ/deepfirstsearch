import { describe, expect, it, vi } from "vitest";
import {
  createOrderGuard,
  OrderRefusedError,
  type OrderBackend,
} from "../../../integrations/order-guard/src/index.js";

const STORE = "fixture-approved-store";
const TOTAL = 1_000;
const INPUT = { storeId: STORE, items: [{ itemId: "fixture-item", quantity: 1 }], tip: 0 };

/** Hypothetical address strings and a backend in memory. The real guard checks
 * the preview; no real address lookup, delivery service or payment is used.
 */
function setup(ownerAddress: string, previewAddress: string) {
  const submit = vi.fn(async (_previewId: string) => ({ orderId: "fixture-order" }));
  const backend: OrderBackend = {
    preview: async () => ({
      previewId: "fixture-preview",
      storeId: STORE,
      deliveryAddress: previewAddress,
      items: [{ name: "Fixture item", quantity: 1, price: TOTAL }],
      subtotal: TOTAL,
      fees: 0,
      tip: 0,
      tax: 0,
      total: TOTAL,
    }),
    submit,
  };
  const guard = createOrderGuard({
    stores: { [STORE]: { label: "Fixture store" } },
    deliveryAddress: ownerAddress,
    maxOrderTotal: TOTAL,
    maxTip: 0,
    dailyBudget: TOTAL * 5,
  }, backend, () => 10_000);
  return { guard, submit };
}

describe("order guard preserves meaningful address text", () => {
  it("accepts the documented ASCII case and punctuation formatting differences", async () => {
    const t = setup("221B Baker St, Apt 2", "221b baker st., apt 2");
    const { preview, wouldBeRefusedFor } = await t.guard.preview(INPUT);
    expect(wouldBeRefusedFor).toEqual([]);
    await expect(t.guard.submit(preview.previewId)).resolves.toMatchObject({ orderId: "fixture-order" });
    expect(t.submit).toHaveBeenCalledOnce();
  });

  it("refuses a different ASCII street before backend submission", async () => {
    const t = setup("10 Alpha Road", "10 Beta Road");
    const { preview, wouldBeRefusedFor } = await t.guard.preview(INPUT);
    expect(wouldBeRefusedFor).toContain("delivery address is not the owner's address");
    await expect(t.guard.submit(preview.previewId)).rejects.toBeInstanceOf(OrderRefusedError);
    expect(t.submit).not.toHaveBeenCalled();
  });

  it("accepts the exact same address written outside the ASCII alphabet", async () => {
    const address = "улица Альфа, 10";
    const t = setup(address, address);
    const { preview, wouldBeRefusedFor } = await t.guard.preview(INPUT);
    expect(wouldBeRefusedFor).toEqual([]);
    await expect(t.guard.submit(preview.previewId)).resolves.toMatchObject({ orderId: "fixture-order" });
    expect(t.submit).toHaveBeenCalledOnce();
  });

  it.each([
    { alphabet: "Cyrillic", owner: "улица Альфа, 10", other: "улица Бета, 10" },
    { alphabet: "Chinese", owner: "甲路10号", other: "乙路10号" },
  ])("refuses distinct $alphabet addresses that share only their house number", async ({ owner, other }) => {
    expect(owner).not.toBe(other);
    const t = setup(owner, other);
    const { preview, wouldBeRefusedFor } = await t.guard.preview(INPUT);
    expect(preview.deliveryAddress).toBe(other);
    const outcome = await t.guard.submit(preview.previewId).then(
      () => "submitted",
      (error: unknown) => error instanceof OrderRefusedError ? "refused" : "unexpected error",
    );

    expect.soft(wouldBeRefusedFor).toContain("delivery address is not the owner's address");
    expect.soft(outcome).toBe("refused");
    expect.soft(t.submit).not.toHaveBeenCalled();
    expect.soft(t.guard.spentToday()).toBe(0);
  });
});
