/**
 * Order guard: owner-set limits for agents that place real orders (food delivery, shopping) through a
 * preview → submit flow, the shape DoorDash's agent ordering tools use (find → cart → preview_order → submit_order).
 *
 * The model can only say "submit preview X". Everything that decides money comes from the owner's policy or from the
 * guard's own record of the preview: which store, the total, the tip, and where the food goes. A prompt-injected
 * agent can ask for 50 burritos, a different address or a store the owner never approved; the guard refuses before
 * the backend's submit is called.
 *
 * Independent open-source project; not affiliated with DoorDash or any delivery platform.
 */

/** Money is in integer cents, never floats. */
export type Cents = number;

export type OrderPolicy = {
  /** The only stores the agent may order from, by the backend's store id. */
  stores: Record<string, { label: string; maxOrderTotal?: Cents }>;
  /** Where orders may be delivered. An order to any other address is refused. */
  deliveryAddress: string;
  /** Cap per order (subtotal + fees + tip + tax), unless a store sets a lower one. */
  maxOrderTotal: Cents;
  maxTip: Cents;
  /** Total spend per rolling 24 h. */
  dailyBudget: Cents;
  /** A preview older than this must be redone before submit (prices and fees change). Default 10 minutes. */
  previewMaxAgeMs?: number;
  /** Orders above this need a human. Without `approve`, they are refused. */
  approvalAbove?: Cents;
  approve?: (order: CheckedPreview) => Promise<boolean>;
};

export type CartItem = { itemId: string; quantity: number };
export type Preview = {
  previewId: string;
  storeId: string;
  deliveryAddress: string;
  items: { name: string; quantity: number; price: Cents }[];
  subtotal: Cents;
  fees: Cents;
  tip: Cents;
  tax: Cents;
  total: Cents;
};
export type CheckedPreview = Preview & { store: string; checkedAt: number };

/** The ordering service (an MCP client, a CLI wrapper or an HTTP API). Only the guard calls submit. */
export interface OrderBackend {
  preview(input: { storeId: string; items: CartItem[]; tip: Cents }): Promise<Preview>;
  submit(previewId: string): Promise<{ orderId: string }>;
  clearCart?(): Promise<void>;
}

export class OrderRefusedError extends Error {
  override name = "OrderRefusedError";
  constructor(readonly reasons: string[]) {
    super(`order refused: ${reasons.join("; ")}`);
  }
}

export type AuditEvent =
  | { type: "preview.checked"; previewId: string; storeId: string; total: Cents; at: number }
  | { type: "order.refused"; previewId?: string; reasons: string[]; at: number }
  | { type: "order.submitted"; previewId: string; orderId: string; total: Cents; at: number }
  | { type: "order.unconfirmed"; previewId: string; total: Cents; at: number };

const normalize = (a: string) => a.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const isCents = (n: unknown): n is Cents => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
const usd = (c: Cents) => `$${(c / 100).toFixed(2)}`;

export function createOrderGuard(policy: OrderPolicy, backend: OrderBackend, now: () => number = Date.now) {
  for (const [k, v] of Object.entries({ maxOrderTotal: policy.maxOrderTotal, maxTip: policy.maxTip, dailyBudget: policy.dailyBudget })) {
    if (!isCents(v)) throw new Error(`${k} must be a non-negative integer number of cents`);
  }
  if (!Object.keys(policy.stores).length) throw new Error("approve at least one store");
  const maxAge = policy.previewMaxAgeMs ?? 10 * 60_000;
  const previews = new Map<string, CheckedPreview>();
  const used = new Set<string>();
  const spent: { at: number; total: Cents }[] = [];
  const audit: AuditEvent[] = [];
  const spentToday = () => spent.filter((s) => s.at > now() - 86_400_000).reduce((a, s) => a + s.total, 0);
  const refuse = (reasons: string[], previewId?: string): never => {
    audit.push({ type: "order.refused", previewId, reasons, at: now() });
    throw new OrderRefusedError(reasons);
  };

  /** What the policy says about a preview. Pure: also used to explain a refusal to the model before submit. */
  function check(p: Preview): string[] {
    const reasons: string[] = [];
    const store = policy.stores[p.storeId];
    if (!store) reasons.push(`store ${p.storeId} is not on the owner's list`);
    if (normalize(p.deliveryAddress) !== normalize(policy.deliveryAddress)) reasons.push("delivery address is not the owner's address");
    for (const k of ["subtotal", "fees", "tip", "tax", "total"] as const) if (!isCents(p[k])) reasons.push(`${k} is not a valid amount`);
    if (isCents(p.total) && p.total !== p.subtotal + p.fees + p.tip + p.tax) reasons.push("total does not add up");
    const cap = Math.min(policy.maxOrderTotal, store?.maxOrderTotal ?? Infinity);
    if (p.total > cap) reasons.push(`total ${usd(p.total)} is above the ${usd(cap)} cap`);
    if (p.tip > policy.maxTip) reasons.push(`tip ${usd(p.tip)} is above the ${usd(policy.maxTip)} cap`);
    if (spentToday() + p.total > policy.dailyBudget) reasons.push(`daily budget: ${usd(policy.dailyBudget - spentToday())} left`);
    return reasons;
  }

  return {
    /** Prices the cart through the backend and records the result. The model sees the preview and the guard's verdict. */
    async preview(input: { storeId: string; items: CartItem[]; tip: Cents }) {
      if (!isCents(input.tip)) refuse(["tip must be a non-negative integer number of cents"]);
      const p = await backend.preview(input);
      const checked: CheckedPreview = { ...p, store: policy.stores[p.storeId]?.label ?? p.storeId, checkedAt: now() };
      previews.set(p.previewId, checked);
      audit.push({ type: "preview.checked", previewId: p.previewId, storeId: p.storeId, total: p.total, at: now() });
      return { preview: checked, wouldBeRefusedFor: check(p) };
    },

    /** Places the order for a preview this guard produced. The only thing the model chooses is which preview. */
    async submit(previewId: string) {
      const p = previews.get(previewId);
      if (!p) return refuse(["unknown preview: run preview first"], previewId);
      if (used.has(previewId)) return refuse(["this preview was already submitted"], previewId);
      if (now() - p.checkedAt > maxAge) return refuse(["preview expired: prices and fees may have changed, preview again"], previewId);
      const reasons = check(p);
      if (reasons.length) return refuse(reasons, previewId);
      if (policy.approvalAbove !== undefined && p.total > policy.approvalAbove) {
        const ok = policy.approve ? await policy.approve(p) : false;
        if (!ok) return refuse([`orders above ${usd(policy.approvalAbove)} need the owner's approval`], previewId);
      }
      // Reserve before calling out: if the backend fails ambiguously the money may be spent, so it stays counted.
      used.add(previewId);
      const entry = { at: now(), total: p.total };
      spent.push(entry);
      try {
        const { orderId } = await backend.submit(previewId);
        audit.push({ type: "order.submitted", previewId, orderId, total: p.total, at: now() });
        return { orderId, total: p.total, store: p.store };
      } catch (e) {
        audit.push({ type: "order.unconfirmed", previewId, total: p.total, at: now() });
        throw e;
      }
    },

    spentToday,
    audit: () => [...audit],
  };
}

export type OrderGuard = ReturnType<typeof createOrderGuard>;
