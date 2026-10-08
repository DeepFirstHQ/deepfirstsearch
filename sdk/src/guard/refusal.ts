/**
 * Stable, machine-readable reason codes for payment refusals. The human-readable reasons can change wording between
 * releases; these codes do not. An agent should branch on the code (or its `action`), never on the reason text.
 *
 * Adding a code is a minor release; renaming or removing one is a breaking change.
 */

/** What the agent should do about a refusal. */
export type RefusalAction =
  /** Possible redirection or tampering. Do not retry; report it to the owner. */
  | "report"
  /** Only the owner can decide (a new price, a declined approval). Do not retry on your own; ask the owner. */
  | "ask_owner"
  /** The owner's configuration does not allow this payment. Do not retry; the owner must change the configuration. */
  | "fix_config"
  /** A budget or plan limit was reached. Retry later, or ask the owner for a bigger plan or budget. */
  | "retry_later";

export const REFUSAL_CODES = {
  /** The origin is not in the owner's merchant registry (or is not https). */
  unknown_merchant: { action: "fix_config", description: "the origin is not an approved merchant" },
  /** The merchant is approved but not part of the sealed spending plan. */
  not_in_plan: { action: "fix_config", description: "the merchant is not in the sealed plan" },
  /** The sealed plan expired (before evaluation or while waiting to sign). */
  plan_expired: { action: "retry_later", description: "the sealed plan expired; a new plan must be sealed" },
  /** The 402 asks to pay an address other than the merchant's registered payTo. */
  payee_mismatch: { action: "report", description: "the 402's payee is not the merchant's registered address" },
  /** The 402 asks for an allowed network that is not the merchant's registered network. */
  network_mismatch: { action: "report", description: "the 402's network is not the merchant's network" },
  /** The 402 asks for a network the owner has not allowed (or one the SDK cannot map, for x402 v1). */
  network_not_allowed: { action: "fix_config", description: "the 402 asks for a network the owner has not allowed" },
  /** The 402's asset or EIP-712 domain differs from the pinned USDC. */
  asset_mismatch: { action: "report", description: "the 402's asset or token domain is not the pinned USDC" },
  /** No asset is pinned for the merchant's network in the owner's configuration. */
  asset_not_pinned: { action: "fix_config", description: "no USDC is pinned for this network" },
  /** The 402 asks for a payment scheme or transfer method the SDK does not sign. */
  scheme_unsupported: { action: "report", description: "the 402 asks for an unsupported scheme or transfer method" },
  /** The 402's price is above the owner's pinned price (plus tolerance). */
  price_changed: { action: "ask_owner", description: "the 402's price differs from the owner's pinned price" },
  /** The amount is above the merchant's per-payment cap. */
  over_cap: { action: "ask_owner", description: "the amount is above the merchant's per-payment cap" },
  /** Not enough is left in the sealed plan for this merchant. */
  plan_exhausted: { action: "retry_later", description: "the sealed plan has not enough left for this payment" },
  /** Not enough is left in the period budget. */
  budget_exhausted: { action: "retry_later", description: "the period budget has not enough left for this payment" },
  /** The 402's maxTimeoutSeconds is outside the accepted bounds. */
  timeout_out_of_bounds: { action: "fix_config", description: "the 402's authorization window is outside the accepted bounds" },
  /** The 402 uses an x402 version this merchant (or the SDK) does not accept. */
  version_not_allowed: { action: "fix_config", description: "the 402's x402 version is not enabled for this merchant" },
  /** The merchant's payee failed sanctions screening, or screening was unavailable (fails closed). */
  sanctioned_payee: { action: "report", description: "the payee failed sanctions screening" },
  /** A human was asked to approve the payment and declined (or no approval channel exists). */
  human_refused: { action: "ask_owner", description: "human approval was refused" },
  /** The 402 is malformed, too large, offers no payment options, a non-positive amount, or came from a cross-origin redirect. */
  invalid_402: { action: "report", description: "the 402 response is invalid or came from somewhere else" },
  /** Generic refusal (the default when no specific code was given). */
  policy_denied: { action: "ask_owner", description: "the payment policy refused this payment" },
} as const satisfies Record<string, { action: RefusalAction; description: string }>;

/** Closed set of refusal codes. */
export type RefusalCode = keyof typeof REFUSAL_CODES;

export function isRefusalCode(v: unknown): v is RefusalCode {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(REFUSAL_CODES, v);
}

export function refusalAction(code: RefusalCode): RefusalAction {
  return REFUSAL_CODES[code].action;
}

const ACTION_RANK: Record<RefusalAction, number> = { report: 0, ask_owner: 1, fix_config: 2, retry_later: 3 };

/**
 * The code that best describes a refusal with several reasons: the most cautious action wins (a possible
 * redirection outranks a spent budget), then the first one listed. `policy_denied` only wins when nothing else is there.
 */
export function primaryRefusalCode(codes: readonly RefusalCode[]): RefusalCode {
  let best: RefusalCode | undefined;
  for (const c of codes) {
    if (c === "policy_denied") continue;
    if (best === undefined || ACTION_RANK[refusalAction(c)] < ACTION_RANK[refusalAction(best)]) best = c;
  }
  return best ?? "policy_denied";
}

/**
 * Codes for PaymentBlockedError: the payment was not refused by policy, it was stopped (or may already have happened).
 * The actions differ from refusals: after `settlement_pending` the agent should request the same resource again (the
 * SDK resends the same signed authorization and never signs a new one); after `settled_not_delivered` it must never pay
 * again. Suggested in coinbase/agentkit#1544.
 */
export type BlockAction = "resend_same" | "report" | "retry_later" | "ask_owner";

export const BLOCK_CODES = {
  /** No receipt confirmed the payment (missing, unreadable or failed settlement). It may still settle. */
  settlement_pending: {
    action: "resend_same",
    description: "the payment may have settled but nothing confirmed it; request the same resource again (the same authorization is resent, nothing new is signed)",
  },
  /** The authorization was used on-chain but the merchant did not deliver the resource. */
  settled_not_delivered: { action: "report", description: "the payment settled on-chain but the merchant did not deliver; never pay again, report it" },
  /** Too many payments in the rate-limit window (per merchant or global). */
  rate_limited: { action: "retry_later", description: "the payment rate limit was reached" },
  /** The owner's kill switch is on. */
  kill_switch: { action: "ask_owner", description: "payments are stopped by the owner's kill switch" },
  /** Generic (the default when no specific code was given). */
  blocked: { action: "ask_owner", description: "the payment was blocked" },
} as const satisfies Record<string, { action: BlockAction; description: string }>;

export type BlockCode = keyof typeof BLOCK_CODES;

export function isBlockCode(v: unknown): v is BlockCode {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(BLOCK_CODES, v);
}
