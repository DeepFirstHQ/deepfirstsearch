import type { Address, Hex, LocalAccount } from "viem";
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
import { effectiveTimeoutBounds, evaluate, type PolicyConfig } from "../policy/engine.js";
import type { Merchant, MerchantRegistry } from "../policy/registry.js";
import type { SanctionsScreen } from "../policy/sanctions.js";
import { decodeHeader, encodeHeader, X402DecodeError } from "./codec.js";
import { signExactAuthorization } from "./exactEvm.js";
import type { AuthorizationCheck } from "./onchain.js";
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
  /**
   * When a merchant's receipt is missing or unreadable after the retries, ask the token whether the signed
   * authorization was used on-chain (see usdcAuthorizationCheck). Used: the payment counts as settled, marked
   * `confirmedOnChain`. Not used, or the check fails: the payment stays unconfirmed, as without this option.
   */
  confirmAuthorization?: AuthorizationCheck;
  /** Retries of a failed settlement, resending the same signed authorization (never a new one). Default 3. */
  settleRetries?: number;
  /** Base delay between those retries, in ms (linear backoff). Default 3000. */
  settleRetryDelayMs?: number;
};

/** How many times the chain is asked about an authorization (settleRetryDelayMs apart) before it counts as unused. */
const CONFIRM_CHECKS = 4;

export type PaidResponse = Response & {
  payment?: { amount: bigint; payTo: string; settlement: SettleResponse; confirmedOnChain?: boolean };
};

/**
 * x402 v2 client with a mandatory policy gate between "the server asked for money" and "we signed".
 *
 * - The 402 response is untrusted: payee, asset, network, price and timeout must match owner configuration.
 * - Payments are only possible inside a plan sealed before the agent read untrusted content.
 * - At most one signature per payment. A failed settlement is retried only by resending that same authorization.
 * - Plan, period and rate-limit budgets are reserved atomically, so concurrent payments cannot overspend them.
 * - Only the selected requirement and the signed payload are sent back; extensions and resource metadata are not.
 */
/** Server- or facilitator-provided reason codes reach the model only as short snake_case codes (SDK-L-3). */
function safeReason(reason: unknown): string {
  return typeof reason === "string" && /^[a-z0-9_]{1,64}$/.test(reason) ? reason : "unrecognized_reason";
}

export function createAgentPay(options: AgentPayOptions) {
  const baseFetch = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const audit = options.audit ?? new AuditLog();
  const approve = options.approve ?? denyAll;
  const kill = new KillSwitch();
  const limiter = new RateLimiter(options.rateLimit?.max ?? 10, options.rateLimit?.windowMs ?? 60_000);
  const humanForAll = requiresHumanForEveryPayment(options.session);
  const periodLedger: { start: number; spent: bigint } = { start: now(), spent: 0n };
  // Signed payments whose settlement was never confirmed, by resource. The server may still have settled them, so if
  // the agent asks for the same resource again we resend that authorization instead of signing a second one (SDK-L-4).
  const unsettled = new Map<string, { headers: Headers; payer: string; authorization: { from: string; nonce: string; validBefore: string } }>();
  // Validated up front, so a bad value can never surface after an authorization has been signed.
  const retries = options.settleRetries ?? 3;
  const backoff = options.settleRetryDelayMs ?? 3_000;
  if (!Number.isInteger(retries) || retries < 0 || retries > 10) throw new Error("settleRetries must be an integer in [0, 10]");
  if (!Number.isFinite(backoff) || backoff < 0) throw new Error("settleRetryDelayMs must be a finite number >= 0");

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
    if (first.redirected && (!first.url || new URL(first.url).origin !== new URL(input).origin)) {
      const reason = `402 came from a redirect to ${first.url ? new URL(first.url).origin : "an unknown origin"}`;
      audit.append({ type: "payment.denied", url: input, reasons: [reason] });
      throw new PaymentDeniedError([reason]);
    }
    // Pay the resource that actually asked for payment (after a same-origin redirect, that is the final URL).
    const payUrl = first.redirected ? first.url : input;

    let required: PaymentRequired;
    try {
      required = decodeHeader(first.headers.get(HEADERS.required) ?? first.headers.get("X-PAYMENT-REQUIRED"), PaymentRequired);
    } catch (e) {
      const reason = e instanceof X402DecodeError ? e.message : "unreadable 402";
      audit.append({ type: "payment.denied", url: input, reasons: [reason] });
      throw new PaymentDeniedError([reason]);
    }

    let decision: ReturnType<typeof evaluate>;
    try {
      decision = evaluate(options.policy, options.registry, {
        url: input,
        required,
        plan: ctx.plan,
        spentInPeriod: spentInPeriod(),
        now: now(),
      });
    } catch (e) {
      // e.g. a non-https URL: refuse it like any other denial, and leave a trace in the audit log.
      const reason = String((e as Error)?.message ?? e).slice(0, 200);
      audit.append({ type: "payment.denied", url: input, reasons: [reason] });
      throw new PaymentDeniedError([reason]);
    }
    if (decision.kind === "deny") {
      audit.append({ type: "payment.denied", url: input, reasons: decision.reasons });
      throw new PaymentDeniedError(decision.reasons);
    }
    const { merchant, asset, amount, requirement } = decision;

    const resourceKey = JSON.stringify([payUrl, (init.method ?? "GET").toUpperCase(), merchant.payTo, asset.asset, amount.toString(), requirement.network]);
    const pendingPayment = unsettled.get(resourceKey);
    if (pendingPayment) {
      unsettled.delete(resourceKey);
      // Its budget was reserved when it was signed. Reuse it while it is comfortably valid; once it has expired it can
      // never execute, so signing a new one below is safe.
      if (Number(pendingPayment.authorization.validBefore) - Math.floor(now() / 1000) >= 15) {
        kill.assertAlive();
        audit.append({ type: "payment.retry", origin: merchant.origin, amount, attempt: 0, reason: "agent retried an unconfirmed payment", nonce: pendingPayment.authorization.nonce });
        return await settle({ input: payUrl, init, headers: pendingPayment.headers, merchant, amount, requirement, payer: pendingPayment.payer, authorization: pendingPayment.authorization, resourceKey });
      }
    }

    // Reserve plan, period and rate-limit budget synchronously, right after the decision and before any await, so
    // concurrent payments cannot all pass the same check (SDK-H-1). Released if nothing is sent.
    try {
      limiter.check(merchant.origin, now());
    } catch (e) {
      audit.append({ type: "payment.denied", url: input, reasons: [(e as Error).message] });
      throw e;
    }
    const periodCap = options.policy.periodBudget?.amount;
    if (periodCap !== undefined && spentInPeriod() + amount > periodCap) {
      const reason = "period budget exhausted";
      audit.append({ type: "payment.denied", url: input, reasons: [reason] });
      throw new PaymentDeniedError([reason]);
    }
    if (!ctx.plan.reserve(merchant.origin, amount)) {
      const reason = "sealed plan budget exhausted";
      audit.append({ type: "payment.denied", url: input, reasons: [reason] });
      throw new PaymentDeniedError([reason]);
    }
    const periodStart = periodLedger.start;
    periodLedger.spent += amount;
    limiter.record(merchant.origin, now());
    let sent = false;
    const releaseReservation = () => {
      if (sent) return;
      ctx.plan.release(merchant.origin, amount);
      if (periodLedger.start === periodStart) periodLedger.spent -= amount;
    };

    try {
      if (options.screen) {
        let flagged: boolean;
        let screenError = "";
        try {
          flagged = await options.screen(merchant.payTo);
        } catch (e) {
          flagged = true; // screening fails closed
          screenError = ` (screen unavailable: ${String((e as Error)?.message ?? e).slice(0, 120)})`;
        }
        if (flagged) {
          const reason = `payee ${merchant.payTo} failed sanctions screening${screenError}`;
          audit.append({ type: "payment.denied", url: input, reasons: [reason] });
          throw new PaymentDeniedError([reason]);
        }
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

      kill.assertAlive(); // approval can take a while
      const payer = await options.payer(merchant, asset.chainId);
      await options.ensureFunded?.(payer, merchant, amount);
      // Re-check after the slow steps (SDK-L-1): the kill switch and the plan's expiry.
      kill.assertAlive();
      if (!ctx.plan.covers(merchant.origin, now())) {
        const reason = "sealed plan expired before signing";
        audit.append({ type: "payment.denied", url: input, reasons: [reason] });
        throw new PaymentDeniedError([reason]);
      }

      const bounds = effectiveTimeoutBounds(options.policy.timeoutBounds, merchant);
      const validFor = Math.min(requirement.maxTimeoutSeconds, bounds.max);
      const { authorization, signature } = await signExactAuthorization({
        account: payer,
        asset,
        to: merchant.payTo, // from the registry, never from the server
        value: amount,
        validForSeconds: validFor,
        nowSeconds: Math.floor(now() / 1000),
      });
      const payload: PaymentPayload = { x402Version: 2, ...(required.resource ? { resource: required.resource } : {}), accepted: requirement, payload: { signature, authorization } };
      audit.append({ type: "payment.signed", origin: merchant.origin, payTo: merchant.payTo, payer: payer.address, amount, nonce: authorization.nonce });

      const headers = new Headers(init.headers);
      headers.set(HEADERS.signature, encodeHeader(payload));
      headers.set("Idempotency-Key", authorization.nonce);
      sent = true; // from here on the money is possibly spent: the reservation stays

      return await settle({ input: payUrl, init, headers, merchant, amount, requirement, payer: payer.address, authorization, resourceKey });
    } finally {
      releaseReservation();
    }
  }

  /**
   * Sends the signed payment and waits for settlement. Retries resend the SAME signed authorization (its EIP-3009
   * nonce can execute at most once, so a retry can never pay twice). The paid request never follows redirects, so the
   * signature only ever goes to the merchant's own origin (SDK-L-2).
   */
  async function settle(p: {
    input: string;
    init: RequestInit;
    headers: Headers;
    merchant: Merchant;
    amount: bigint;
    requirement: PaymentRequired["accepts"][number];
    payer: string;
    authorization: { from: string; nonce: string; validBefore: string };
    resourceKey: string;
  }): Promise<PaidResponse> {
    let paid!: PaidResponse;
    let settlement: SettleResponse | undefined;
    let failure = "";
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt > 0) {
        if (Number(p.authorization.validBefore) - Math.floor(now() / 1000) < 15) break; // about to expire
        await new Promise((r) => setTimeout(r, backoff * attempt));
        try {
          kill.assertAlive();
        } catch (e) {
          unsettled.set(p.resourceKey, { headers: p.headers, payer: p.payer, authorization: p.authorization });
          audit.append({ type: "payment.failed", origin: p.merchant.origin, amount: p.amount, reason: "killed during settlement retries" });
          throw e;
        }
        audit.append({ type: "payment.retry", origin: p.merchant.origin, amount: p.amount, attempt, reason: failure, nonce: p.authorization.nonce });
      }
      try {
        paid = (await baseFetch(p.input, { ...p.init, headers: p.headers, redirect: "manual" })) as PaidResponse;
      } catch {
        settlement = undefined;
        failure = "network error";
        continue;
      }
      if (paid.status >= 300 && paid.status < 400) {
        settlement = undefined;
        failure = `redirect (HTTP ${paid.status}) refused for a paid request`;
        break; // resending to the same URL would only be redirected again
      }
      try {
        settlement = decodeHeader(paid.headers.get(HEADERS.response) ?? paid.headers.get(HEADERS.legacyResponse), SettleResponse);
      } catch {
        settlement = undefined;
        failure = `missing or invalid PAYMENT-RESPONSE (HTTP ${paid.status})`;
        // The resource was delivered without a readable receipt: the chain answers that better than a resend, which a
        // merchant that already settled can only refuse (CoinMarketCap answers it with a new 402), losing the resource.
        if (paid.ok && options.confirmAuthorization) break;
        continue;
      }
      if (!settlement.success) {
        failure = safeReason(settlement.errorReason);
        continue;
      }
      // Settlement must describe what we signed (SDK-I-7).
      if (settlement.network && settlement.network !== p.requirement.network) {
        failure = "settlement reported a different network";
        settlement = undefined;
        break;
      }
      if (settlement.payer && settlement.payer.toLowerCase() !== p.payer.toLowerCase()) {
        failure = "settlement reported a different payer";
        settlement = undefined;
        break;
      }
      break;
    }
    if ((!settlement || !settlement.success) && options.confirmAuthorization) {
      // The receipt didn't confirm it; the chain can. Only reached on this failure path (no extra calls otherwise).
      // A merchant can answer before its settlement transaction is mined, so the chain is asked a few times.
      let used = false;
      for (let check = 0; check < CONFIRM_CHECKS && !used; check++) {
        if (check > 0) await new Promise((r) => setTimeout(r, backoff));
        try {
          used = await options.confirmAuthorization({
            network: p.requirement.network,
            asset: p.requirement.asset as Address,
            authorizer: p.authorization.from as Address,
            nonce: p.authorization.nonce as Hex,
          });
        } catch {
          used = false; // an unreachable RPC leaves the payment unconfirmed
        }
      }
      if (used) {
        audit.append({ type: "payment.settled_onchain", origin: p.merchant.origin, amount: p.amount, nonce: p.authorization.nonce, status: paid?.status, receipt: failure });
        if (!paid?.ok) {
          // The money moved but the merchant didn't deliver: never resend (the authorization is spent), say so plainly.
          throw new PaymentBlockedError(
            `the authorization was used on-chain (the payment settled) but the merchant answered HTTP ${paid?.status ?? "none"} instead of the resource`,
          );
        }
        paid.payment = { amount: p.amount, payTo: p.merchant.payTo, settlement: { success: true, transaction: "", network: p.requirement.network, payer: p.payer }, confirmedOnChain: true };
        return paid;
      }
    }
    if (!settlement || !settlement.success) {
      unsettled.set(p.resourceKey, { headers: p.headers, payer: p.payer, authorization: p.authorization });
      audit.append({ type: "payment.failed", origin: p.merchant.origin, amount: p.amount, status: paid?.status, reason: failure });
      throw new PaymentBlockedError(
        `settlement not confirmed (${failure}); the same authorization was retried, never re-signed, and is resent if this resource is requested again while it is valid`,
      );
    }
    audit.append({ type: "payment.settled", origin: p.merchant.origin, amount: p.amount, tx: settlement.transaction, network: settlement.network });
    paid.payment = { amount: p.amount, payTo: p.merchant.payTo, settlement };
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
