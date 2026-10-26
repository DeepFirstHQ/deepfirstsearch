import { describe, expect, it, vi } from "vitest";
import {
  createOrderGuard,
  OrderRefusedError,
  type OrderBackend,
  type OrderPolicy,
} from "../../../integrations/order-guard/src/index.js";

const PREVIEW_MAX_AGE = 1_000;
const TOTAL = 1_000;
const INPUT = { storeId: "fixture-store", items: [{ itemId: "fixture-item", quantity: 1 }], tip: 0 };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

/** The real order guard with a fake clock and a backend that only counts calls.
 * No ordering service, account, payment or network connection is used.
 */
function setup(approval: NonNullable<OrderPolicy["approve"]> = async () => true) {
  let clock = 10_000;
  const submit = vi.fn(async (_previewId: string) => ({ orderId: "fixture-order" }));
  const backend: OrderBackend = {
    preview: async () => ({
      previewId: "fixture-preview",
      storeId: INPUT.storeId,
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
  const approve = vi.fn(approval);
  const guard = createOrderGuard({
    stores: { [INPUT.storeId]: { label: "Fixture store" } },
    deliveryAddress: "Fixture address",
    maxOrderTotal: TOTAL,
    maxTip: 0,
    dailyBudget: TOTAL * 5,
    previewMaxAgeMs: PREVIEW_MAX_AGE,
    approvalAbove: 500,
    approve,
  }, backend, () => clock);
  return { guard, submit, approve, advance(ms: number) { clock += ms; } };
}

describe("order guard preview validity around an approval wait", () => {
  it("submits a fresh, approved preview once", async () => {
    const t = setup();
    const { preview } = await t.guard.preview(INPUT);
    await expect(t.guard.submit(preview.previewId)).resolves.toMatchObject({ orderId: "fixture-order", total: TOTAL });
    expect(t.approve).toHaveBeenCalledOnce();
    expect(t.submit).toHaveBeenCalledExactlyOnceWith(preview.previewId);
    expect(t.guard.spentToday()).toBe(TOTAL);
  });

  it("refuses an already-expired preview before approval or backend submission", async () => {
    const t = setup();
    const { preview } = await t.guard.preview(INPUT);
    t.advance(PREVIEW_MAX_AGE + 1);
    await expect(t.guard.submit(preview.previewId)).rejects.toBeInstanceOf(OrderRefusedError);
    expect(t.approve).not.toHaveBeenCalled();
    expect(t.submit).not.toHaveBeenCalled();
    expect(t.guard.spentToday()).toBe(0);
  });

  it("releases the reservation when approval is declined", async () => {
    const t = setup(async () => false);
    const { preview } = await t.guard.preview(INPUT);
    await expect(t.guard.submit(preview.previewId)).rejects.toBeInstanceOf(OrderRefusedError);
    expect(t.approve).toHaveBeenCalledOnce();
    expect(t.submit).not.toHaveBeenCalled();
    expect(t.guard.spentToday()).toBe(0);
  });

  it("refuses a preview that expires while approval is pending, before calling the backend", async () => {
    const entered = deferred<void>();
    const answer = deferred<boolean>();
    const t = setup(() => {
      entered.resolve(undefined);
      return answer.promise;
    });
    const { preview } = await t.guard.preview(INPUT);
    const outcome = t.guard.submit(preview.previewId).then(
      (value) => ({ kind: "submitted" as const, value }),
      (error: unknown) => ({ kind: "refused" as const, error }),
    );
    await entered.promise;
    expect(t.submit).not.toHaveBeenCalled();
    expect(t.guard.spentToday()).toBe(TOTAL);
    t.advance(PREVIEW_MAX_AGE + 1);
    answer.resolve(true);

    expect.soft(await outcome).toMatchObject({
      kind: "refused",
      error: expect.objectContaining({
        name: "OrderRefusedError",
        reasons: expect.arrayContaining([expect.stringMatching(/expired/)]),
      }),
    });
    expect.soft(t.submit).not.toHaveBeenCalled();
    expect.soft(t.guard.spentToday()).toBe(0);
  });
});
