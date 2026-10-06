import { createHash, randomUUID } from "node:crypto";
import type { MerchantRegistry } from "../policy/registry.js";
import { canonicalOrigin } from "../policy/registry.js";

export type PlanItem = { origin: string; maxSpend: bigint };

/**
 * Plan-then-execute. Before the agent reads any untrusted content, it commits to the set of merchants it may pay
 * and how much. The plan is frozen: nothing the agent reads afterwards (web pages, tool output, 402 bodies) can add
 * a payee or raise a budget. Changing the plan means sealing a new one, which the caller should gate behind a human.
 */
export class SealedPlan {
  readonly id = randomUUID();
  readonly hash: string;
  readonly expiresAt: number;
  // Real private fields: nothing outside this class can read or change the limits or the spend.
  readonly #limits: ReadonlyMap<string, bigint>;
  readonly #spent = new Map<string, bigint>();

  constructor(items: PlanItem[], expiresAt: number) {
    const limits = new Map<string, bigint>();
    for (const item of items) {
      if (item.maxSpend <= 0n) throw new Error("plan budgets must be positive");
      const origin = canonicalOrigin(item.origin);
      if (limits.has(origin)) throw new Error(`duplicate plan origin: ${origin}`);
      limits.set(origin, item.maxSpend);
    }
    this.#limits = limits;
    this.expiresAt = expiresAt;
    const canonical = JSON.stringify([...limits.entries()].sort().map(([o, v]) => [o, v.toString()]));
    this.hash = createHash("sha256").update(canonical).update(String(expiresAt)).digest("hex");
    Object.freeze(this);
  }

  covers(origin: string, now: number): boolean {
    return now < this.expiresAt && this.#limits.has(origin);
  }

  remaining(origin: string): bigint {
    const limit = this.#limits.get(origin) ?? 0n;
    return limit - (this.#spent.get(origin) ?? 0n);
  }

  /**
   * Checks and reserves in one synchronous step, so concurrent payments cannot all see the same remaining budget.
   * Returns false (reserving nothing) if the amount does not fit.
   */
  reserve(origin: string, amount: bigint): boolean {
    if (amount <= 0n || amount > this.remaining(origin)) return false;
    this.#spent.set(origin, (this.#spent.get(origin) ?? 0n) + amount);
    return true;
  }

  /** Gives back a reservation for a payment that was never sent. */
  release(origin: string, amount: bigint): void {
    const spent = this.#spent.get(origin) ?? 0n;
    if (amount <= 0n || amount > spent) throw new Error("invalid plan release");
    this.#spent.set(origin, spent - amount);
  }
}

/** Seals a plan. Every origin must already be an owner-approved merchant. */
export function commitPlan(registry: MerchantRegistry, items: PlanItem[], ttlMs: number, now = Date.now()): SealedPlan {
  for (const item of items) {
    if (!registry.forUrl(item.origin)) throw new Error(`plan names a merchant that is not in the registry: ${item.origin}`);
  }
  return new SealedPlan(items, now + ttlMs);
}
