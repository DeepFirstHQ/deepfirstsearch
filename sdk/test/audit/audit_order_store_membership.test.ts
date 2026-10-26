import { describe, expect, it, vi } from "vitest";
import {
  createOrderGuard,
  OrderRefusedError,
  type OrderBackend,
} from "../../../integrations/order-guard/src/index.js";

const REGISTERED_STORE = "fixture-approved-store";
const TOTAL = 1_000;

/** Real guard, ordinary owner configuration and an in-memory backend. The backend
 * can price any fixture identifier; the guard must enforce the owner's store list.
 * No prototypes are modified and no external orders or payments are made.
 */
function setup(registeredStore = REGISTERED_STORE) {
  const stores = { [registeredStore]: { label: "Explicitly registered fixture store" } };
  const submit = vi.fn(async (_previewId: string) => ({ orderId: "fixture-order" }));
  const backend: OrderBackend = {
    preview: async ({ storeId }) => ({
      previewId: "fixture-preview",
      storeId,
      deliveryAddress: "Fixture address",
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
    stores,
    deliveryAddress: "Fixture address",
    maxOrderTotal: TOTAL,
    maxTip: 0,
    dailyBudget: TOTAL * 5,
  }, backend, () => 10_000);
  const preview = (storeId: string) => guard.preview({
    storeId,
    items: [{ itemId: "fixture-item", quantity: 1 }],
    tip: 0,
  });
  return { stores, guard, submit, preview };
}

describe("order guard requires explicit store membership", () => {
  it("permits a store explicitly present in the owner's configuration", async () => {
    const t = setup();
    const { preview, wouldBeRefusedFor } = await t.preview(REGISTERED_STORE);
    expect(wouldBeRefusedFor).toEqual([]);
    await expect(t.guard.submit(preview.previewId)).resolves.toMatchObject({ orderId: "fixture-order" });
    expect(t.submit).toHaveBeenCalledOnce();
  });

  it("refuses an ordinary unknown identifier without submitting", async () => {
    const t = setup();
    const { preview, wouldBeRefusedFor } = await t.preview("fixture-unregistered-store");
    expect(wouldBeRefusedFor).toEqual(expect.arrayContaining([expect.stringContaining("not on the owner's list")]));
    await expect(t.guard.submit(preview.previewId)).rejects.toBeInstanceOf(OrderRefusedError);
    expect(t.submit).not.toHaveBeenCalled();
    expect(t.guard.spentToday()).toBe(0);
  });

  it.each(["constructor", "toString", "__proto__"])(
    "does not mistake the inherited property %s for a registered store",
    async (storeId) => {
      const t = setup();
      expect(Object.keys(t.stores)).toEqual([REGISTERED_STORE]);
      expect(Object.hasOwn(t.stores, storeId)).toBe(false);
      const { preview, wouldBeRefusedFor } = await t.preview(storeId);
      const outcome = await t.guard.submit(preview.previewId).then(
        () => "submitted",
        (error: unknown) => error instanceof OrderRefusedError ? "refused" : "unexpected error",
      );

      expect.soft(wouldBeRefusedFor).toEqual(expect.arrayContaining([expect.stringContaining("not on the owner's list")]));
      expect.soft(outcome).toBe("refused");
      expect.soft(t.submit).not.toHaveBeenCalled();
      expect.soft(t.guard.spentToday()).toBe(0);
    },
  );

  it("permits a special-looking identifier when the owner explicitly registers it", async () => {
    const t = setup("constructor");
    expect(Object.hasOwn(t.stores, "constructor")).toBe(true);
    const { preview, wouldBeRefusedFor } = await t.preview("constructor");
    expect(wouldBeRefusedFor).toEqual([]);
    await expect(t.guard.submit(preview.previewId)).resolves.toMatchObject({ orderId: "fixture-order" });
    expect(t.submit).toHaveBeenCalledOnce();
  });
});
