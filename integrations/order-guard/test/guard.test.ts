import { describe, expect, it } from "vitest";
import { createOrderGuard, OrderRefusedError, type OrderPolicy } from "../src/index.js";
import { createMockDelivery } from "../src/testing.js";

const HOME = "221B Baker St, Apt 2";
const policy = (over: Partial<OrderPolicy> = {}): OrderPolicy => ({
  stores: { "la-taqueria": { label: "La Taqueria" } },
  deliveryAddress: HOME,
  maxOrderTotal: 3000,
  maxTip: 500,
  dailyBudget: 4000,
  ...over,
});
const setup = (over: Partial<OrderPolicy> = {}) => {
  let t = 1_000_000;
  const backend = createMockDelivery({ address: HOME });
  const guard = createOrderGuard(policy(over), backend, () => t);
  return { backend, guard, advance: (ms: number) => (t += ms) };
};
const burrito = { storeId: "la-taqueria", items: [{ itemId: "carnitas-burrito", quantity: 1 }], tip: 200 };
const refusal = (p: Promise<unknown>) => p.then(() => { throw new Error("expected a refusal"); }, (e) => { expect(e).toBeInstanceOf(OrderRefusedError); return (e as OrderRefusedError).reasons.join(" | "); });

describe("order guard", () => {
  it("places an honest order inside the limits", async () => {
    const { guard, backend } = setup();
    const { preview, wouldBeRefusedFor } = await guard.preview(burrito);
    expect(wouldBeRefusedFor).toEqual([]);
    const r = await guard.submit(preview.previewId);
    expect(r.total).toBe(1250 + 188 + 200 + 109);
    expect(backend.orders).toHaveLength(1);
    expect(guard.spentToday()).toBe(r.total);
  });

  it("refuses a store the owner never approved, without calling submit", async () => {
    const { guard, backend } = setup();
    const { preview } = await guard.preview({ storeId: "burrito-palace", items: [{ itemId: "super-burrito", quantity: 1 }], tip: 200 });
    expect(await refusal(guard.submit(preview.previewId))).toMatch(/not on the owner's list/);
    expect(backend.orders).toHaveLength(0);
  });

  it("refuses an order to an address the agent was talked into", async () => {
    const { guard, backend } = setup();
    backend.setDeliveryAddress("77 Harbor Rd"); // the injected "the customer moved"
    const { preview } = await guard.preview(burrito);
    expect(await refusal(guard.submit(preview.previewId))).toMatch(/delivery address/);
    expect(backend.orders).toHaveLength(0);
  });

  it("treats formatting differences in the owner's address as the same address", async () => {
    const { guard, backend } = setup();
    backend.setDeliveryAddress("221b baker st., apt 2");
    const { preview } = await guard.preview(burrito);
    await expect(guard.submit(preview.previewId)).resolves.toMatchObject({ orderId: "ord_1" });
  });

  it("refuses 40 burritos (over the order cap) and a tip over the tip cap", async () => {
    const { guard } = setup();
    const big = await guard.preview({ ...burrito, items: [{ itemId: "carnitas-burrito", quantity: 40 }] });
    expect(await refusal(guard.submit(big.preview.previewId))).toMatch(/above the \$30\.00 cap/);
    const tip = await guard.preview({ ...burrito, tip: 5000 });
    expect(await refusal(guard.submit(tip.preview.previewId))).toMatch(/tip \$50\.00 is above/);
  });

  it("applies a lower per-store cap", async () => {
    const { guard } = setup({ stores: { "la-taqueria": { label: "La Taqueria", maxOrderTotal: 1500 } } });
    const { preview } = await guard.preview(burrito);
    expect(await refusal(guard.submit(preview.previewId))).toMatch(/above the \$15\.00 cap/);
  });

  it("stops at the daily budget and frees it after 24 hours", async () => {
    const { guard, advance } = setup();
    await guard.submit((await guard.preview(burrito)).preview.previewId);
    await guard.submit((await guard.preview({ ...burrito, tip: 0 })).preview.previewId);
    const third = await guard.preview(burrito);
    expect(await refusal(guard.submit(third.preview.previewId))).toMatch(/daily budget/);
    advance(86_400_001);
    const fresh = await guard.preview(burrito);
    await expect(guard.submit(fresh.preview.previewId)).resolves.toBeTruthy();
  });

  it("refuses unknown, replayed and expired previews", async () => {
    const { guard, advance } = setup();
    expect(await refusal(guard.submit("pv_999"))).toMatch(/unknown preview/);
    const { preview } = await guard.preview(burrito);
    await guard.submit(preview.previewId);
    expect(await refusal(guard.submit(preview.previewId))).toMatch(/already submitted/);
    const late = await guard.preview(burrito);
    advance(10 * 60_000 + 1);
    expect(await refusal(guard.submit(late.preview.previewId))).toMatch(/expired/);
  });

  it("asks the owner above the approval threshold, and refuses without an approver", async () => {
    const asked: number[] = [];
    const yes = setup({ approvalAbove: 1000, approve: async (o) => (asked.push(o.total), true) });
    await yes.guard.submit((await yes.guard.preview(burrito)).preview.previewId);
    expect(asked).toHaveLength(1);
    const no = setup({ approvalAbove: 1000 });
    expect(await refusal(no.guard.submit((await no.guard.preview(burrito)).preview.previewId))).toMatch(/approval/);
  });

  it("refuses a preview whose amounts don't add up or aren't integer cents", async () => {
    const backend = createMockDelivery({ address: HOME });
    const lying = { ...backend, preview: async (i: Parameters<typeof backend.preview>[0]) => ({ ...(await backend.preview(i)), total: 100 }) };
    const guard = createOrderGuard(policy(), lying);
    expect(await refusal(guard.submit((await guard.preview(burrito)).preview.previewId))).toMatch(/does not add up/);
    await expect(guard.preview({ ...burrito, tip: 1.5 })).rejects.toThrow(OrderRefusedError);
  });

  it("keeps an ambiguous submit counted against the budget", async () => {
    const backend = createMockDelivery({ address: HOME });
    const flaky = { ...backend, submit: async () => { throw new Error("timeout"); } };
    const guard = createOrderGuard(policy(), flaky);
    const { preview } = await guard.preview(burrito);
    await expect(guard.submit(preview.previewId)).rejects.toThrow("timeout");
    expect(guard.spentToday()).toBe(preview.total);
    expect(guard.audit().at(-1)?.type).toBe("order.unconfirmed");
  });

  it("validates the policy", () => {
    const b = createMockDelivery({ address: HOME });
    expect(() => createOrderGuard(policy({ maxOrderTotal: 12.5 }), b)).toThrow(/cents/);
    expect(() => createOrderGuard(policy({ stores: {} }), b)).toThrow(/at least one store/);
  });
});
