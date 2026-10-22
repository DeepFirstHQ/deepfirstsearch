import { getAddress } from "viem";
import type { Merchant } from "@deepfirstsearch/agent-pay";

/**
 * Agent Safe for the Cloudflare Agents SDK (`agents/x402`).
 *
 * `withX402Client(client, { account, confirmationCallback })` lets a Cloudflare agent pay x402 over MCP, and asks a
 * `confirmationCallback(payment: PaymentRequirements[]) => Promise<boolean>` whether the payment may go ahead. This
 * module builds that callback from the owner's allowlist, so the agent — even prompt-injected — can only ever pay the
 * payee the owner pinned for that server, on an allowed network, in the pinned USDC, within the per-payment cap, the
 * price pin, the window and a session budget. Anything outside that returns `false`, and the client signs nothing.
 *
 * The callback decides the whole `402` (it cannot pick which option the client pays), so it approves only when **every**
 * offered option is within policy: a 402 that mixes a safe option with a swapped-payee one is refused in full. The
 * callback is per wrapped client, and a client talks to one MCP server, so you pass that server's `origin`; its entry
 * in your `MerchantRegistry` pins the rules. No new runtime dependency is added to the SDK.
 */

/** The subset of an x402 `PaymentRequirements` the policy reads. Structurally compatible with `agents/x402`. */
export type PaymentRequirements = {
  scheme?: string;
  network: string;
  /** Amount in atomic units of `asset`, as a decimal string. */
  maxAmountRequired: string;
  payTo: string;
  asset: string;
  resource?: string;
  maxTimeoutSeconds?: number;
  extra?: Record<string, unknown>;
};

/** Why a payment option was not approved. Passed to `onRefusal` for logging; it is data, never model instructions. */
export type Refusal = { code: string; detail: string };

export type AgentSafeConfirmationOptions = {
  /**
   * The owner-approved merchant this wrapped client pays — the single MCP server it talks to. Uses the same `Merchant`
   * shape as the rest of Agent Safe (`payTo`, `network`, `maxPerTx`, optional `pricePin`/`toleranceBps`/`maxTimeoutSeconds`).
   */
  merchant: Merchant;
  /** Total this client may spend across the session, in atomic units of the pinned asset. Omit for no session cap (per-payment caps still apply). */
  sessionBudget?: bigint;
  /** Networks (CAIP-2 or legacy name) a payment may be on. Default: the merchant's network only. */
  allowedNetworks?: readonly string[];
  /** Called with the reason each time a payment is refused. For logging/metrics; refusals are data, not exceptions. */
  onRefusal?: (reason: Refusal) => void;
};

/** USDC by network, so a 402 can't swap in a different token (whose decimals would make the amount lie). */
const USDC: Record<string, string> = {
  "eip155:8453": "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  "eip155:84532": "0x036cbd53842c5426634e7929541ec2318f3dcf7e",
};

/** Cloudflare accepts legacy names and CAIP-2; normalize both so comparisons are exact. */
const LEGACY: Record<string, string> = { base: "eip155:8453", "base-sepolia": "eip155:84532" };
function caip2(network: string): string {
  const n = String(network).trim().toLowerCase();
  return LEGACY[n] ?? n;
}

function sameAddress(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  try {
    return getAddress(a) === getAddress(b);
  } catch {
    return String(a).toLowerCase() === String(b).toLowerCase();
  }
}

/** Checks one payment option against the pinned merchant (not the budget). Returns a refusal, or null when acceptable. */
function refuse(r: PaymentRequirements, m: Merchant, allowed: Set<string>): Refusal | null {
  if (!sameAddress(r.payTo, m.payTo)) return { code: "payee_mismatch", detail: `payTo ${r.payTo} is not the pinned ${m.payTo}` };
  const net = caip2(r.network);
  if (!allowed.has(net)) return { code: "network_not_allowed", detail: `network ${r.network} is not allowed` };
  const expectedAsset = USDC[net];
  if (expectedAsset && !sameAddress(r.asset, expectedAsset)) return { code: "asset_not_allowed", detail: `asset ${r.asset} is not the pinned USDC on ${net}` };
  let amount: bigint;
  try {
    amount = BigInt(r.maxAmountRequired);
  } catch {
    return { code: "unreadable_amount", detail: `maxAmountRequired ${r.maxAmountRequired} is not an integer` };
  }
  if (amount <= 0n) return { code: "unreadable_amount", detail: `maxAmountRequired ${r.maxAmountRequired} is not positive` };
  if (amount > m.maxPerTx) return { code: "over_cap", detail: `${amount} exceeds the per-payment cap ${m.maxPerTx}` };
  if (m.pricePin !== undefined) {
    const tol = BigInt(m.toleranceBps ?? 0);
    const max = m.pricePin + (m.pricePin * tol) / 10_000n;
    if (amount > max) return { code: "price_changed", detail: `${amount} exceeds the pinned price ${m.pricePin}` };
  }
  if (m.maxTimeoutSeconds !== undefined && r.maxTimeoutSeconds !== undefined && r.maxTimeoutSeconds > m.maxTimeoutSeconds) {
    return { code: "window_too_long", detail: `validity ${r.maxTimeoutSeconds}s exceeds the cap ${m.maxTimeoutSeconds}s` };
  }
  return null;
}

/**
 * Builds the `confirmationCallback` for `withX402Client`. Approves a payment only if **every** option pays the pinned
 * payee on an allowed network, in the pinned USDC, within the per-payment cap, the price pin and the window — and the
 * largest option still fits the session budget. The budget is tracked across calls on the returned function, so give
 * each wrapped client its own.
 */
export function agentSafeConfirmation(opts: AgentSafeConfirmationOptions): (payment: PaymentRequirements[]) => Promise<boolean> {
  const merchant = opts.merchant;
  if (!merchant || typeof merchant !== "object") throw new Error("agentSafeConfirmation: a merchant is required");
  try {
    getAddress(merchant.payTo);
  } catch {
    throw new Error(`agentSafeConfirmation: merchant.payTo is not a valid address: ${merchant.payTo}`);
  }
  if (typeof merchant.maxPerTx !== "bigint" || merchant.maxPerTx <= 0n) {
    throw new Error("agentSafeConfirmation: merchant.maxPerTx must be a positive bigint (atomic units)");
  }
  if (merchant.pricePin !== undefined && (typeof merchant.pricePin !== "bigint" || merchant.pricePin <= 0n)) {
    throw new Error("agentSafeConfirmation: merchant.pricePin must be a positive bigint (atomic units)");
  }
  const allowed = new Set((opts.allowedNetworks ?? [merchant.network]).map(caip2));
  let spent = 0n;

  return async (payment: PaymentRequirements[]): Promise<boolean> => {
    if (!Array.isArray(payment) || payment.length === 0) {
      opts.onRefusal?.({ code: "no_options", detail: "the 402 offered no payment options" });
      return false;
    }
    // Every option must be acceptable, because the client — not this callback — chooses which one to pay.
    let largest = 0n;
    for (const r of payment) {
      const reason = refuse(r, merchant, allowed);
      if (reason) {
        opts.onRefusal?.(reason);
        return false;
      }
      const amount = BigInt(r.maxAmountRequired);
      if (amount > largest) largest = amount;
    }
    if (opts.sessionBudget !== undefined && spent + largest > opts.sessionBudget) {
      opts.onRefusal?.({ code: "budget_exhausted", detail: `${largest} would exceed the remaining session budget ${opts.sessionBudget - spent}` });
      return false;
    }
    spent += largest; // the client pays one option; count the largest, conservatively.
    return true;
  };
}
