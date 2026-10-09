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
  /**
   * x402 protocol versions this merchant may be paid with. Default `[2]`. Set `[1, 2]` (or `[1]`) only for a merchant
   * you know still speaks x402 v1; every policy check applies to v1 payments unchanged. There is no global switch.
   */
  x402Versions?: readonly (1 | 2)[];
  /**
   * Keys of extensions this merchant declares in its 402 that are echoed back in the payment (x402 v2 only), e.g.
   * `["builder-code"]` for a seller whose Base Builder Code reaches settlement only through the buyer's payload. Default:
   * none. Anything not listed is never echoed. The echoed value is the merchant's own declaration, size-capped.
   */
  echoExtensions?: readonly string[];
  /**
   * The owner's own ERC-8021 service builder codes, added to this merchant's `builder-code` extension as `s` (requires
   * `"builder-code"` in `echoExtensions`). 1 to 32 lowercase letters, digits or underscores each.
   */
  builderCodes?: readonly string[];
};

const EXTENSION_KEY = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const BUILDER_CODE = /^[a-z0-9_]{1,32}$/;

export const DEFAULT_X402_VERSIONS: readonly (1 | 2)[] = Object.freeze([2] as const);

/** The x402 versions a merchant accepts (its `x402Versions`, or `[2]`). */
export function merchantVersions(m: Merchant): readonly (1 | 2)[] {
  return m.x402Versions ?? DEFAULT_X402_VERSIONS;
}

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
      if (m.maxTimeoutSeconds !== undefined) {
        if (!Number.isInteger(m.maxTimeoutSeconds)) throw new Error("maxTimeoutSeconds must be an integer");
        if (m.maxTimeoutSeconds < 10 || m.maxTimeoutSeconds > 86400) {
          throw new Error("maxTimeoutSeconds must be between 10 and 86400");
        }
      }
      if (m.x402Versions !== undefined) {
        const v = m.x402Versions as readonly unknown[];
        if (!Array.isArray(v) || v.length === 0 || v.some((x) => x !== 1 && x !== 2) || new Set(v).size !== v.length) {
          throw new Error("x402Versions must be a non-empty list of distinct versions from [1, 2]");
        }
      }
      if (m.echoExtensions !== undefined) {
        const e = m.echoExtensions as readonly unknown[];
        if (!Array.isArray(e) || e.length > 8 || e.some((k) => typeof k !== "string" || !EXTENSION_KEY.test(k)) || new Set(e).size !== e.length) {
          throw new Error("echoExtensions must be up to 8 distinct extension keys (letters, digits, _ or -)");
        }
      }
      if (m.builderCodes !== undefined) {
        const c = m.builderCodes as readonly unknown[];
        if (!Array.isArray(c) || c.length === 0 || c.length > 4 || c.some((k) => typeof k !== "string" || !BUILDER_CODE.test(k)) || new Set(c).size !== c.length) {
          throw new Error("builderCodes must be 1 to 4 distinct codes of 1-32 lowercase letters, digits or underscores");
        }
        if (!m.echoExtensions?.includes("builder-code")) throw new Error('builderCodes requires "builder-code" in echoExtensions');
      }
      const origin = canonicalOrigin(m.origin);
      if (this.byOrigin.has(origin)) throw new Error(`duplicate merchant origin: ${origin}`);
      this.byOrigin.set(
        origin,
        Object.freeze({
          ...m,
          origin,
          payTo: getAddress(m.payTo),
          ...(m.x402Versions ? { x402Versions: Object.freeze([...m.x402Versions]) } : {}),
          ...(m.echoExtensions ? { echoExtensions: Object.freeze([...m.echoExtensions]) } : {}),
          ...(m.builderCodes ? { builderCodes: Object.freeze([...m.builderCodes]) } : {}),
        }),
      );
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
