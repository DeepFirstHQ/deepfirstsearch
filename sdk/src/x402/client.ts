import type { LocalAccount } from "viem";
import { AuditLog } from "../guard/audit.js";
import {
  denyAll,
  KillSwitch,
  PaymentBlockedError,
  PaymentDeniedError,
  RateLimiter,
  requiresHumanForEveryPayment,
  type ApprovalHook,
  type SessionCapabilities,
} from "../guard/controls.js";
import { commitPlan, type PlanItem, type SealedPlan } from "../guard/plan.js";
import { evaluate, type PolicyConfig } from "../policy/engine.js";
import type { Merchant, MerchantRegistry } from "../policy/registry.js";
import type { SanctionsScreen } from "../policy/sanctions.js";
import { decodeHeader, encodeHeader, X402DecodeError } from "./codec.js";
import { signExactAuthorization } from "./exactEvm.js";
import { HEADERS, PaymentRequired, SettleResponse, type PaymentPayload } from "./schemas.js";

export type PayerProvider = (merchant: Merchant, chainId: number) => LocalAccount | Promise<LocalAccount>;

export type AgentPayOptions = {
  registry: MerchantRegistry;
  policy: PolicyConfig;
  payer: PayerProvider;
  session: SessionCapabilities;
  approve?: ApprovalHook;
  audit?: AuditLog;
  rateLimit?: { max: number; windowMs: number };
  /** Sanctions screening run on every payee before signing (see policy/sanctions.ts). Strongly recommended. */
  screen?: SanctionsScreen;
  /** Called before signing so the caller can top up the merchant's burner from the vault. */
  ensureFunded?: (payer: LocalAccount, merchant: Merchant, amount: bigint) => Promise<void>;
  fetch?: typeof fetch;
  now?: () => number;
};

export type PaidResponse = Response & { payment?: { amount: bigint; payTo: string; settlement: SettleResponse } };

/**
 * x402 v2 client with a mandatory policy gate between "the server asked for money" and "we signed".
 *
 * - The 402 response is untrusted: payee, asset, network, price and timeout must match owner configuration.
 * - Payments are only possible inside a plan sealed before the agent read untrusted content.
 * - No automatic retries: one request, at most one signature. A failed settlement is reported, never re-signed.
 * - Only the selected requirement and the signed payload are sent back; extensions and resource metadata are not.
 */
export function createAgentPay(options: AgentPayOptions) {
  const baseFetch = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const audit = options.audit ?? new AuditLog();
  const approve = options.approve ?? denyAll;
  const kill = new KillSwitch();
  const limiter = new RateLimiter(options.rateLimit?.max ?? 10, options.rateLimit?.windowMs ?? 60_000);
  const humanForAll = requiresHumanForEveryPayment(options.session);
  const periodLedger: { start: number; spent: bigint } = { start: now(), spent: 0n };

  function spentInPeriod(): bigint {
    const period = options.policy.periodBudget?.periodMs;
    if (period && now() - periodLedger.start >= period) {
      periodLedger.start = now();
      periodLedger.spent = 0n;
    }
    return periodLedger.spent;
  }

  async function payingFetch(input: string, init: RequestInit = {}, ctx: { plan: SealedPlan }): Promise<PaidResponse> {
    kill.assertAlive();
    const first = await baseFetch(input, init);
    if (first.status !== 402) return first;
    // A 402 reached through a redirect belongs to wherever we were redirected, not to the merchant we asked.
    if (first.redirected && first.url && new URL(first.url).origin !== new URL(input).origin) {
      const reason = `402 came from a redirect to ${new URL(first.url).origin}`;
      audit.append({ type: "payment.denied", url: input, reasons: [reason] });
      throw new PaymentDeniedError([reason]);
    }

    let required: PaymentRequired;
    try {
      required = decodeHeader(first.headers.get(HEADERS.required), PaymentRequired);
    } catch (e) {
      const reason = e instanceof X402DecodeError ? e.message : "unreadable 402";
      audit.append({ type: "payment.denied", url: input, reasons: [reason] });
      throw new PaymentDeniedError([reason]);
    }

    const decision = evaluate(options.policy, options.registry, {
      url: input,
      required,
      plan: ctx.plan,
      spentInPeriod: spentInPeriod(),
      now: now(),
    });
    if (decision.kind === "deny") {
      audit.append({ type: "payment.denied", url: input, reasons: decision.reasons });
      throw new PaymentDeniedError(decision.reasons);
    }

    const { merchant, asset, amount, requirement } = decision;
    limiter.check(merchant.origin, now());

    if (options.screen && (await options.screen(merchant.payTo))) {
      const reason = `payee ${merchant.payTo} failed sanctions screening`;
      audit.append({ type: "payment.denied", url: input, reasons: [reason] });
      throw new PaymentDeniedError([reason]);
    }

    if (decision.kind === "needsApproval" || humanForAll) {
      const reasons = humanForAll ? [...decision.reasons, "session holds all three Rule-of-Two capabilities"] : decision.reasons;
      audit.append({ type: "payment.approval_requested", origin: merchant.origin, amount, reasons });
      const ok = await approve({ origin: merchant.origin, payTo: merchant.payTo, amount, network: requirement.network, reasons });
      if (!ok) {
        audit.append({ type: "payment.approval_refused", origin: merchant.origin, amount });
        throw new PaymentDeniedError(["human approval refused", ...reasons]);
      }
    }

    // Re-check the kill switch: approval can take a while.
    kill.assertAlive();
    const payer = await options.payer(merchant, asset.chainId);
    await options.ensureFunded?.(payer, merchant, amount);

    const validFor = Math.min(requirement.maxTimeoutSeconds, options.policy.timeoutBounds?.max ?? 300);
    const { authorization, signature } = await signExactAuthorization({
      account: payer,
      asset,
      to: merchant.payTo, // from the registry, never from the server
      value: amount,
      validForSeconds: validFor,
      nowSeconds: Math.floor(now() / 1000),
    });
    const payload: PaymentPayload = { x402Version: 2, accepted: requirement, payload: { signature, authorization } };

    // Account before sending: if the request fails after this point we treat the money as possibly spent.
    ctx.plan.record(merchant.origin, amount);
    periodLedger.spent += amount;
    limiter.record(merchant.origin, now());
    audit.append({ type: "payment.signed", origin: merchant.origin, payTo: merchant.payTo, payer: payer.address, amount, nonce: authorization.nonce });

    const headers = new Headers(init.headers);
    headers.set(HEADERS.signature, encodeHeader(payload));
    headers.set("Idempotency-Key", authorization.nonce);
    const paid = (await baseFetch(input, { ...init, headers })) as PaidResponse;

    let settlement: SettleResponse;
    try {
      settlement = decodeHeader(paid.headers.get(HEADERS.response), SettleResponse);
    } catch {
      audit.append({ type: "payment.failed", origin: merchant.origin, amount, status: paid.status, reason: "missing or invalid PAYMENT-RESPONSE" });
      throw new PaymentBlockedError(`payment sent but settlement unconfirmed (HTTP ${paid.status}); not retrying`);
    }
    if (!settlement.success) {
      audit.append({ type: "payment.failed", origin: merchant.origin, amount, reason: settlement.errorReason ?? "unknown" });
      throw new PaymentBlockedError(`settlement failed: ${settlement.errorReason ?? "unknown"}; not retrying`);
    }
    audit.append({ type: "payment.settled", origin: merchant.origin, amount, tx: settlement.transaction, network: settlement.network });
    paid.payment = { amount, payTo: merchant.payTo, settlement };
    return paid;
  }

  return {
    /** Seal the spending plan. Call this before the agent reads any untrusted content. */
    commitPlan(items: PlanItem[], ttlMs: number): SealedPlan {
      const plan = commitPlan(options.registry, items, ttlMs, now());
      audit.append({ type: "plan.sealed", plan: plan.id, hash: plan.hash, items });
      return plan;
    },
    fetch: payingFetch,
    kill: (reason?: string) => kill.kill(reason),
    audit,
  };
}
