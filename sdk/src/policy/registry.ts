import { getAddress, type Address } from "viem";
import type { Tainted } from "../guard/taint.js";

/** A merchant the owner has approved, keyed by the exact origin the agent talks to. */
export type Merchant = {
  origin: string;
  payTo: Address;
  network: string;
  /** Hard cap per payment, in atomic units. */
  maxPerTx: bigint;
  /** Expected price in atomic units; payments above `pricePin * (1 + tolerance)` are refused. */
  pricePin?: bigint;
  /** Tolerance in basis points over `pricePin` (default 0). */
  toleranceBps?: number;
  label?: string;
  /** Per-merchant authorization window override in seconds. */
  maxTimeoutSeconds?: number;
};

function canonicalOrigin(url: string): string {
  const u = new URL(url);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1"))) {
    throw new Error(`refusing non-https origin: ${u.origin}`);
  }
  return u.origin;
}

/**
 * Owner-configured allowlist. This is the only source of truth for who may be paid. Lookups are by exact origin:
 * no wildcards, no suffix matching, no redirects followed into the registry.
 */
export class MerchantRegistry {
  private readonly byOrigin = new Map<string, Merchant>();

  constructor(merchants: Merchant[]) {
    for (const m of merchants) {
      const origin = canonicalOrigin(m.origin);
      if (this.byOrigin.has(origin)) throw new Error(`duplicate merchant origin: ${origin}`);
      this.byOrigin.set(origin, Object.freeze({ ...m, origin, payTo: getAddress(m.payTo) }));
    }
  }

  forUrl(url: string): Merchant | undefined {
    return this.byOrigin.get(canonicalOrigin(url));
  }

  /** Turns a tainted origin into a trusted merchant only on an exact match. */
  resolve(origin: Tainted<string>): Merchant | undefined {
    try {
      return this.byOrigin.get(canonicalOrigin(origin.value));
    } catch {
      return undefined;
    }
  }

  origins(): string[] {
    return [...this.byOrigin.keys()];
  }
}

export { canonicalOrigin };
