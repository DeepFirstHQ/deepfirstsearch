import type { SealedPlan } from "../guard/plan.js";
import { evaluate, type Decision, type PolicyConfig } from "../policy/engine.js";
import type { MerchantRegistry } from "../policy/registry.js";
import { decodeHeader, X402DecodeError } from "./codec.js";
import { HEADERS, PaymentRequired } from "./schemas.js";
import { looksLikeV1, normalizeV1, parseV1, readBodyCapped } from "./v1.js";

/**
 * What the policy would do with a seller's answer, without a key: every outcome is a value, never an exception.
 *
 * - `no_challenge`: the seller showed no payment terms (any status but 402, or a 402 with neither a
 *   PAYMENT-REQUIRED header nor an x402 v1 body). Nothing to decide.
 * - `invalid_402`: a 402 whose terms could not be read (malformed, oversized, or failing the strict schema).
 * - `allow`, `needsApproval`, `deny`: the policy's decision, exactly as `evaluate` returns it.
 */
export type DryRunVerdict =
  | { kind: "no_challenge"; status: number; reason: string }
  | { kind: "invalid_402"; status: 402; reason: string }
  | (Decision & { status: 402; version: 1 | 2 });

export type DryRunContext = {
  /** The URL that was requested: the merchant is always this origin, never one the 402 names. */
  url: string;
  policy: PolicyConfig;
  registry: MerchantRegistry;
  plan: SealedPlan;
  spentInPeriod?: bigint;
  now?: number;
};

/**
 * The decision layer on its own: read a response the way `pay.fetch` does and ask the policy what it would do. Nothing
 * is signed and no key is needed. Reads the response body when it has to look for an x402 v1 402 (capped).
 */
export async function dryRun(res: Response, ctx: DryRunContext): Promise<DryRunVerdict> {
  if (res.status !== 402) return { kind: "no_challenge", status: res.status, reason: `HTTP ${res.status}: no payment terms` };

  let required: PaymentRequired;
  let version: 1 | 2 = 2;
  const header = res.headers.get(HEADERS.required) ?? res.headers.get("X-PAYMENT-REQUIRED");
  try {
    if (header !== null) {
      required = decodeHeader(header, PaymentRequired);
    } else {
      const text = await readBodyCapped(res);
      if (text === undefined) return { kind: "invalid_402", status: 402, reason: "402 body too large" };
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
      if (!looksLikeV1(json)) {
        return { kind: "no_challenge", status: 402, reason: "402 without a PAYMENT-REQUIRED header or an x402 v1 body" };
      }
      required = normalizeV1(parseV1(json)).required;
      version = 1;
    }
  } catch (e) {
    return { kind: "invalid_402", status: 402, reason: e instanceof X402DecodeError ? e.message : "unreadable 402" };
  }

  try {
    const decision = evaluate(ctx.policy, ctx.registry, {
      url: ctx.url,
      required,
      plan: ctx.plan,
      spentInPeriod: ctx.spentInPeriod ?? 0n,
      now: ctx.now ?? Date.now(),
    });
    return { ...decision, status: 402, version };
  } catch (e) {
    // e.g. a non-https URL, which the registry refuses outright.
    const reason = String((e as Error)?.message ?? e).slice(0, 200);
    const code = reason.startsWith("refusing non-https origin") ? "unknown_merchant" : "policy_denied";
    return { kind: "deny", reasons: [reason], codes: [code], status: 402, version };
  }
}
