import type { Address, Hex, LocalAccount } from "viem";
import { AuditLog, type AuditEvent } from "../guard/audit.js";
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
import type { RefusalCode } from "../guard/refusal.js";
import { assertPolicy, effectiveTimeoutBounds, evaluate, type PolicyConfig } from "../policy/engine.js";
import { merchantVersions, type Merchant, type MerchantRegistry } from "../policy/registry.js";
import type { SanctionsScreen } from "../policy/sanctions.js";
import { decodeHeader, encodeHeader, X402DecodeError } from "./codec.js";
import { signExactAuthorization } from "./exactEvm.js";
import type { AuthorizationCheck } from "./onchain.js";
import { caip2ToV1Network, HEADERS, PaymentRequired, SettleResponse, type PaymentPayload, type PaymentRequirements } from "./schemas.js";
import { decodeV1Receipt, DEFAULT_TIMEOUT_MS, looksLikeV1, normalizeV1, parseV1, readBodyCapped, v1Payload } from "./v1.js";

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
   * `confirmedOnChain`. Not used, unknown, or the check fails: the payment stays unconfirmed, as without this option.
   * A merchant's "already used" answer is also checked here before it counts as paid.
   */
  confirmAuthorization?: AuthorizationCheck;
  /** Retries of a failed settlement, resending the same signed authorization (never a new one). Default 3. */
  settleRetries?: number;
  /** Base delay between those retries, in ms (linear backoff). Default 3000. */
  settleRetryDelayMs?: number;
  /**
   * Time limit, in ms, on the unpaid request and on reading a 402 body. Default 30000. Combined with the caller's own
   * `init.signal`, if any. The paid request is not cut short: its retries already resend the same authorization.
   */
  timeoutMs?: number;
};

/** How many times the chain is asked about an authorization (settleRetryDelayMs apart) before it counts as unused. */
const CONFIRM_CHECKS = 4;

/**
 * An unconfirmed authorization is treated as expired only this long after its validBefore, so the chain's clock (block
 * timestamps) has certainly passed it too. Until then it could still settle, and nothing new is signed.
 */
const EXPIRY_MARGIN_SECONDS = 60;

/**
 * A merchant's answer to a resent payment that says the authorization was already consumed. Seen live: tx_already_used,
 * nonce_already_used_locally / _on_chain, nonce_replayed_local, nonce_already_used(_onchain) (the Automaton Sovereign family,
 * one per settlement path), "nonce already used" (CoinMarketCap). Matched as a family, never as one exact string.
 */
const ALREADY_USED = /already[_ -]?(?:been[_ -]?)?(?:used|consumed|settled|spent)|nonce[_ -](?:has[_ -]been[_ -]|was[_ -])?(?:used|replayed)|replayed/i;

/** A settlement transaction hash; any other `transaction` in a receipt is reported as "" (not provided). */
const TX_HASH = /^0x[0-9a-fA-F]{64}$/;

/** A signed authorization whose settlement is not confirmed, kept until it is confirmed, proven unused, or forgotten. */
type Unsettled = {
  /** The resource: JSON [origin + path + query, method]. Payment terms are not part of it. */
  key: string;
  headers: Headers;
  payer: string;
  version: 1 | 2;
  authorization: { from: string; nonce: string; validBefore: string };
  merchant: Merchant;
  amount: bigint;
  requirement: PaymentRequirements;
  /** The pinned asset address (never the 402's spelling of it). */
  asset: Address;
  /** Being sent right now: nothing else may be sent or signed for this resource until it returns. */
  inFlight?: boolean;
  /** Known to be paid (on-chain, or the merchant said the proof was already used) but not delivered. */
  settled?: true;
};

/** The resource a payment is for: origin, path and query (the fragment never reaches a server). */
function resourceOf(url: string): string {
  try {
    const u = new URL(url);
    return u.origin + u.pathname + u.search;
  } catch {
    return url;
  }
}

function resourceKeyOf(url: string, method: string | undefined): string {
  return JSON.stringify([resourceOf(url), (method ?? "GET").toUpperCase()]);
}

/** The caller's signal (if any) plus a time limit. */
function withTimeout(signal: AbortSignal | null | undefined, ms: number): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export type PaidResponse = Response & {
  payment?: {
    amount: bigint;
    payTo: string;
    settlement: SettleResponse;
    confirmedOnChain?: boolean;
    /**
     * Set when the merchant had no readable receipt but said so in `X-Payment-Settled` (`true`: settled, `queued`:
     * settlement in flight). The resource was delivered either way; the authorization was sent once.
     */
    merchantSettled?: "true" | "queued";
  };
};

/**
 * x402 client (v2; v1 only for merchants that opt in with `x402Versions`) with a mandatory policy gate between "the server asked for money" and "we signed".
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
  // Signed payments whose settlement is not confirmed, by nonce; `key` names the resource. One is entered, in flight,
  // as soon as it is signed. The server may have settled it, so while one exists for a resource nothing new is signed
  // for it: a later request resends it (same terms) or is blocked (SDK-L-4, M-1).
  const unsettled = new Map<string, Unsettled>();
  // Validated up front, so a bad value can never surface after an authorization has been signed.
  const retries = options.settleRetries ?? 3;
  const backoff = options.settleRetryDelayMs ?? 3_000;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(retries) || retries < 0 || retries > 10) throw new Error("settleRetries must be an integer in [0, 10]");
  if (!Number.isFinite(backoff) || backoff < 0) throw new Error("settleRetryDelayMs must be a finite number >= 0");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new Error("timeoutMs must be a positive integer");
  assertPolicy(options.policy);

  /**
   * Audit for an authorization that was already sent: a failed write must not lose the paid response or the pending
   * entry, so it never throws. The entry stays in `audit.entries` and the failure is counted in `audit.writeErrors`.
   */
  function record(event: AuditEvent): void {
    try {
      audit.append(event);
    } catch {
      /* counted in audit.writeErrors; written again with the next append */
    }
  }

  /** Settles a sent authorization (in flight). If settle ends without resolving it, it stays pending, never dropped. */
  async function send(entry: Unsettled, input: string, init: RequestInit): Promise<PaidResponse> {
    const nonce = entry.authorization.nonce;
    try {
      return await settle({ ...entry, input, init });
    } finally {
      const e = unsettled.get(nonce);
      if (e?.inFlight) unsettled.set(nonce, { ...e, inFlight: false });
    }
  }

  /** Records how a sent authorization ended: still pending, paid but not delivered, or done (settled and delivered). */
  function resolve(nonce: string, state: "pending" | "settled" | "done"): void {
    const e = unsettled.get(nonce);
    if (!e) return; // forgotten by the owner meanwhile
    if (state === "done") unsettled.delete(nonce);
    else unsettled.set(nonce, { ...e, inFlight: false, ...(state === "settled" ? { settled: true as const } : {}) });
  }

  function spentInPeriod(): bigint {
    const period = options.policy.periodBudget?.periodMs;
    if (period && now() - periodLedger.start >= period) {
      periodLedger.start = now();
      periodLedger.spent = 0n;
    }
    return periodLedger.spent;
  }

  /**
   * A 402 without a payment header may be x402 v1 (JSON body). The body is read only up to a fixed cap, and a v1 402
   * is strictly parsed only for a merchant that opted in; for any other origin the policy refuses it with a clear
   * reason. Returns undefined when the body is not a v1 402 (the caller then reports the missing header).
   */
  async function readV1Body(res: Response, url: string): Promise<{ required: PaymentRequired; skipped: string[] } | undefined> {
    let merchant: Merchant | undefined;
    try {
      merchant = options.registry.forUrl(url);
    } catch {
      merchant = undefined; // e.g. a non-https URL: the policy refuses it below
    }
    const optedIn = merchant !== undefined && merchantVersions(merchant).includes(1);
    const text = await readBodyCapped(res, undefined, timeoutMs);
    if (text === undefined) {
      if (optedIn) throw new X402DecodeError("402 body too large");
      return undefined;
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return undefined;
    }
    if (!looksLikeV1(json)) return undefined;
    // Not opted in (or unknown origin): hand the policy a bare v1 marker so it refuses with the reason naming the
    // option. The body of such a 402 is never parsed further.
    if (!optedIn) return { required: { x402Version: 1, accepts: [] }, skipped: [] };
    return normalizeV1(parseV1(json));
  }

  /** Every refusal is audited with its reasons and stable codes, then thrown. */
  function refuse(url: string, reasons: string[], codes: RefusalCode[]): never {
    audit.append({ type: "payment.denied", url, reasons, codes });
    throw new PaymentDeniedError(reasons, codes);
  }

  async function payingFetch(input: string, init: RequestInit = {}, ctx: { plan: SealedPlan }): Promise<PaidResponse> {
    kill.assertAlive();
    const first = await baseFetch(input, { ...init, signal: withTimeout(init.signal, timeoutMs) });
    if (first.status !== 402) return first;
    // A 402 reached through a redirect belongs to wherever we were redirected, not to the merchant we asked.
    if (first.redirected && (!first.url || new URL(first.url).origin !== new URL(input).origin)) {
      const reason = `402 came from a redirect to ${first.url ? new URL(first.url).origin : "an unknown origin"}`;
      refuse(input, [reason], ["invalid_402"]);
    }
    // Pay the resource that actually asked for payment (after a same-origin redirect, that is the final URL).
    const payUrl = first.redirected ? first.url : input;

    let required: PaymentRequired;
    let version: 1 | 2 = 2;
    let skipped: string[] = [];
    try {
      const header = first.headers.get(HEADERS.required) ?? first.headers.get("X-PAYMENT-REQUIRED");
      const v1 = header === null ? await readV1Body(first, input) : undefined;
      if (v1) {
        ({ required, skipped } = v1);
        version = 1;
      } else {
        required = decodeHeader(header, PaymentRequired);
      }
    } catch (e) {
      const reason = e instanceof X402DecodeError ? e.message : "unreadable 402";
      refuse(input, [reason], ["invalid_402"]);
    }

    // An earlier authorization for this resource that may still pay is handled before the policy: resending it spends
    // nothing new, so a budget used up by that very payment must not stand in the way (I-2).
    const resourceKey = resourceKeyOf(payUrl, init.method);
    for (;;) {
      const entries = [...unsettled.values()].filter((e) => e.key === resourceKey);
      const pendingPayment = entries[0];
      if (!pendingPayment) break;
      if (entries.some((e) => e.settled)) {
        throw new PaymentBlockedError(
          "this resource was already paid (the authorization was used) but not delivered; not paying again. Report it, or clear it with forgetUnsettled(url) once resolved",
          "settled_not_delivered",
        );
      }
      if (entries.some((e) => e.inFlight)) {
        throw new PaymentBlockedError(
          "a payment for this resource is being sent right now and may settle; nothing new is signed. Request it again once that one has returned",
          "settlement_pending",
        );
      }
      const left = Number(pendingPayment.authorization.validBefore) - Math.floor(now() / 1000);
      const nonce = pendingPayment.authorization.nonce;
      if (left >= 15) {
        if (!sameTerms(required, pendingPayment)) {
          // A different price, payee or option: the earlier authorization may still execute, so nothing new is signed.
          throw new PaymentBlockedError(
            `an unconfirmed payment for this resource may still settle and this 402 asks for different terms; nothing new is signed until it is confirmed or expires (in about ${left + EXPIRY_MARGIN_SECONDS}s)`,
            "settlement_pending",
          );
        }
        // Its budget was reserved when it was signed. Reuse it while it is comfortably valid, marked in flight before
        // any await so a concurrent request for the same resource is blocked instead of signing.
        kill.assertAlive();
        const entry = { ...pendingPayment, inFlight: true };
        unsettled.set(nonce, entry);
        record({ type: "payment.retry", origin: entry.merchant.origin, amount: entry.amount, attempt: 0, reason: "agent retried an unconfirmed payment", nonce });
        // Resent exactly as first sent (same header, same version).
        return await send(entry, payUrl, init);
      }
      if (left > -EXPIRY_MARGIN_SECONDS) {
        // Too close to expiry to resend, but it may still execute: signing another now could pay twice.
        throw new PaymentBlockedError(
          `an unconfirmed payment for this resource may still settle until its authorization expires (in about ${Math.max(0, left) + EXPIRY_MARGIN_SECONDS}s); nothing new is signed before then`,
          "settlement_pending",
        );
      }
      // Expired. It can no longer execute, but it may have executed before expiring (an unreadable receipt does not
      // mean unpaid). Sign a new one only when the chain says the old one was never used, read past its validBefore.
      let used: boolean | undefined;
      if (options.confirmAuthorization) {
        try {
          used = await options.confirmAuthorization({
            network: pendingPayment.requirement.network,
            asset: pendingPayment.asset,
            authorizer: pendingPayment.authorization.from as Address,
            nonce: nonce as Hex,
            validBefore: BigInt(pendingPayment.authorization.validBefore),
          });
        } catch {
          used = undefined; // unreachable RPC: unknown
        }
      }
      if (unsettled.get(nonce) !== pendingPayment) continue; // changed while the chain was asked: look again
      if (used === true) {
        unsettled.set(nonce, { ...pendingPayment, settled: true });
        record({ type: "payment.settled_onchain", origin: pendingPayment.merchant.origin, amount: pendingPayment.amount, nonce, receipt: "found on-chain after the authorization expired" });
        throw new PaymentBlockedError(
          "the earlier authorization for this resource was used on-chain (it was paid) but the resource was not delivered; not paying again",
          "settled_not_delivered",
        );
      }
      if (used !== false) {
        throw new PaymentBlockedError(
          options.confirmAuthorization
            ? "an earlier payment for this resource expired without confirmation and the chain could not tell yet whether it was used (no client for the network, or the RPC is behind or unreachable); signing another could pay twice. Try again later, or call forgetUnsettled(url) after checking it yourself"
            : "an earlier payment for this resource expired without confirmation and may have been paid; signing another could pay twice. " +
              "Enable confirmAuthorization so the chain can tell, or call forgetUnsettled(url) after checking it yourself",
          "settlement_unknown",
        );
      }
      unsettled.delete(nonce); // expired and never used: it can never execute, so a new authorization is safe
      record({ type: "payment.expired_unused", origin: pendingPayment.merchant.origin, amount: pendingPayment.amount, nonce });
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
      refuse(input, [reason], [reason.startsWith("refusing non-https origin") ? "unknown_merchant" : "policy_denied"]);
    }
    if (decision.kind === "deny") {
      // A v1 402 whose every option was on a network outside the table: say which, not just "no payment options".
      const onlySkipped = skipped.length > 0 && decision.reasons.length === 1 && decision.reasons[0] === "server offered no payment options";
      // Skipped v1 options were on networks outside the fixed table.
      const skippedCodes = skipped.map((): RefusalCode => "network_not_allowed");
      const reasons = onlySkipped ? skipped : [...decision.reasons, ...skipped];
      const codes = onlySkipped ? skippedCodes : [...decision.codes, ...skippedCodes];
      refuse(input, reasons, codes);
    }
    const { merchant, asset, amount, requirement } = decision;

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
      refuse(input, ["period budget exhausted"], ["budget_exhausted"]);
    }
    if (!ctx.plan.reserve(merchant.origin, amount)) {
      refuse(input, ["sealed plan budget exhausted"], ["plan_exhausted"]);
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
        try {
          flagged = await options.screen(merchant.payTo);
        } catch {
          // Fail closed, but never copy the screen's own error (which may carry internal URLs or credentials) into
          // the model-visible refusal (DFS-06). The owner's screen callback is the place to log its own diagnostics.
          flagged = true;
        }
        if (flagged) {
          refuse(input, [`payee ${merchant.payTo} failed sanctions screening`], ["sanctioned_payee"]);
        }
      }

      if (decision.kind === "needsApproval" || humanForAll) {
        const reasons = humanForAll ? [...decision.reasons, "session holds all three Rule-of-Two capabilities"] : decision.reasons;
        audit.append({ type: "payment.approval_requested", origin: merchant.origin, amount, reasons });
        const ok = await approve({ origin: merchant.origin, payTo: merchant.payTo, amount, network: requirement.network, reasons });
        if (!ok) {
          audit.append({ type: "payment.approval_refused", origin: merchant.origin, amount, codes: ["human_refused"] });
          const refused = ["human approval refused", ...reasons];
          throw new PaymentDeniedError(refused, refused.map((): RefusalCode => "human_refused"));
        }
      }

      kill.assertAlive(); // approval can take a while
      const payer = await options.payer(merchant, asset.chainId);
      await options.ensureFunded?.(payer, merchant, amount);
      // Re-check after the slow steps (SDK-L-1): the kill switch and the plan's expiry.
      kill.assertAlive();
      if (!ctx.plan.covers(merchant.origin, now())) {
        refuse(input, ["sealed plan expired before signing"], ["plan_expired"]);
      }

      if (version === 1 && !caip2ToV1Network(requirement.network)) {
        throw new PaymentDeniedError(["x402 v1 network is not supported"], ["network_not_allowed"]); // unreachable: normalizeV1 maps only table entries
      }
      // Worked out before signing, so nothing about it can fail once an authorization exists.
      const echo = version === 2 ? echoedExtensions(required, merchant) : { skipped: [] as string[] };
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
      const headers = new Headers(init.headers);
      // Never both: a request carries exactly one payment header, in the version the merchant spoke.
      headers.delete(HEADERS.signature);
      headers.delete(HEADERS.v1Signature);
      if (version === 1) {
        headers.set(HEADERS.v1Signature, encodeHeader(v1Payload(requirement, { signature, authorization })));
      } else {
        const payload: PaymentPayload = {
          x402Version: 2,
          ...(required.resource ? { resource: required.resource } : {}),
          accepted: requirement,
          ...(echo.extensions ? { extensions: echo.extensions } : {}),
          payload: { signature, authorization },
        };
        headers.set(HEADERS.signature, encodeHeader(payload));
      }
      // The 402's own resource URL is the server's description of itself: logged when it names another origin, never
      // used for a decision. The merchant is always the origin the agent actually contacted.
      const declared = declaredOrigin(required, requirement);
      audit.append({
        type: "payment.signed",
        origin: merchant.origin,
        payTo: merchant.payTo,
        payer: payer.address,
        amount,
        nonce: authorization.nonce,
        ...(declared !== undefined && declared !== merchant.origin ? { declaredOrigin: declared } : {}),
        ...(echo.extensions ? { echoed: Object.keys(echo.extensions) } : {}),
        ...(echo.skipped.length > 0 ? { notEchoed: echo.skipped } : {}),
      });

      headers.set("Idempotency-Key", authorization.nonce);
      // In flight from now until settlement is confirmed or the authorization is proven unused: no other request for this
      // resource signs meanwhile (M-1). Set synchronously, before anything is sent.
      const entry: Unsettled = { key: resourceKey, headers, payer: payer.address, version, authorization, merchant, amount, requirement, asset: asset.asset as Address, inFlight: true };
      unsettled.set(authorization.nonce, entry);
      sent = true; // from here on the money is possibly spent: the reservation stays

      // A stop that arrived while the signer was pending (DFS-02) must still prevent this first send. The
      // authorization already exists and is recorded in `unsettled` above, so nothing re-signs; we only refuse
      // to transmit it.
      kill.assertAlive();
      return await send(entry, payUrl, init);
    } finally {
      releaseReservation();
    }
  }

  /**
   * Sends the signed payment and waits for settlement. Retries resend the SAME signed authorization (its EIP-3009
   * nonce can execute at most once, so a retry can never pay twice). The paid request never follows redirects, so the
   * signature only ever goes to the merchant's own origin (SDK-L-2).
   */
  async function settle(p: Unsettled & { input: string; init: RequestInit }): Promise<PaidResponse> {
    const nonce = p.authorization.nonce;
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
          resolve(nonce, "pending");
          record({ type: "payment.failed", origin: p.merchant.origin, amount: p.amount, reason: "killed during settlement retries" });
          throw e;
        }
        record({ type: "payment.retry", origin: p.merchant.origin, amount: p.amount, attempt, reason: failure, nonce });
      }
      try {
        paid = (await baseFetch(p.input, { ...p.init, headers: p.headers, redirect: "manual" })) as PaidResponse;
      } catch {
        settlement = undefined;
        failure = "network error";
        continue;
      }
      // The merchant says the authorization was already consumed: it was paid. Resending can't help and nothing may be
      // re-signed; the resource was not delivered.
      if (!paid.ok && (await saysAlreadyUsed(paid))) {
        if (options.confirmAuthorization) {
          // Only the merchant's word (a body can say "replayed" for other reasons): the chain decides below, and the
          // authorization is not resent meanwhile.
          settlement = undefined;
          failure = "merchant says the authorization was already used";
          break;
        }
        resolve(nonce, "settled");
        record({ type: "payment.failed", origin: p.merchant.origin, amount: p.amount, status: paid.status, reason: "merchant says the authorization was already used" });
        throw new PaymentBlockedError(
          `the merchant answered HTTP ${paid.status} saying this authorization was already used: it was paid but the resource was not delivered; not paying again`,
          "settled_not_delivered",
        );
      }
      if (paid.status >= 300 && paid.status < 400) {
        settlement = undefined;
        failure = `redirect (HTTP ${paid.status}) refused for a paid request`;
        break; // resending to the same URL would only be redirected again
      }
      try {
        settlement = p.version === 1
          ? decodeV1Receipt(paid.headers)
          : decodeHeader(paid.headers.get(HEADERS.response) ?? paid.headers.get(HEADERS.legacyResponse), SettleResponse);
      } catch {
        settlement = undefined;
        failure = `missing or invalid ${p.version === 1 ? "X-PAYMENT-RESPONSE" : "PAYMENT-RESPONSE"} (HTTP ${paid.status})`;
        // The resource was delivered without a readable receipt: the chain answers that better than a resend, which a
        // merchant that already settled can only refuse (CoinMarketCap answers it with a new 402), losing the resource.
        // A merchant without a standard receipt may still say it settled (X-Payment-Settled: true | queued).
        const said = paid.ok ? paid.headers.get("X-Payment-Settled")?.trim().toLowerCase() : undefined;
        if (said === "true" || said === "queued") {
          resolve(nonce, "done");
          record({ type: "payment.settled_by_merchant", origin: p.merchant.origin, amount: p.amount, nonce, state: said });
          // X-Payment-Tx, when present, is the merchant's claim of the settlement hash: kept only if it is shaped like one.
          const txHeader = paid.headers.get("X-Payment-Tx")?.trim() ?? "";
          const transaction = TX_HASH.test(txHeader) ? txHeader : "";
          paid.payment = { amount: p.amount, payTo: p.merchant.payTo, settlement: { success: true, transaction, network: p.requirement.network, payer: p.payer }, merchantSettled: said };
          return paid;
        }
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
          used = (await options.confirmAuthorization({
            network: p.requirement.network,
            asset: p.asset, // the pinned address, never the 402's spelling of it
            authorizer: p.authorization.from as Address,
            nonce: nonce as Hex,
          })) === true;
        } catch {
          used = false; // an unreachable RPC leaves the payment unconfirmed
        }
      }
      if (used) {
        record({ type: "payment.settled_onchain", origin: p.merchant.origin, amount: p.amount, nonce, status: paid?.status, receipt: failure });
        if (!paid?.ok) {
          // The money moved but the merchant didn't deliver: never resend (the authorization is spent), say so plainly.
          resolve(nonce, "settled");
          throw new PaymentBlockedError(
            `the authorization was used on-chain (the payment settled) but the merchant answered HTTP ${paid?.status ?? "none"} instead of the resource`,
            "settled_not_delivered",
          );
        }
        resolve(nonce, "done");
        paid.payment = { amount: p.amount, payTo: p.merchant.payTo, settlement: { success: true, transaction: "", network: p.requirement.network, payer: p.payer }, confirmedOnChain: true };
        return paid;
      }
    }
    if (!settlement || !settlement.success) {
      resolve(nonce, "pending");
      record({ type: "payment.failed", origin: p.merchant.origin, amount: p.amount, status: paid?.status, reason: failure });
      throw new PaymentBlockedError(
        `settlement not confirmed (${failure}); the same authorization was retried, never re-signed, and is resent if this resource is requested again while it is valid`,
        "settlement_pending",
      );
    }
    resolve(nonce, "done");
    // The receipt reaches the agent and the audit log: the transaction only when shaped like a hash, and no free text
    // on success (errorReason is read only on failure, through safeReason; a null one, as CDP sends, is harmless).
    const receipt: SettleResponse = { ...settlement, transaction: TX_HASH.test(settlement.transaction) ? settlement.transaction : "" };
    if (receipt.errorReason != null) delete receipt.errorReason;
    record({ type: "payment.settled", origin: p.merchant.origin, amount: p.amount, tx: receipt.transaction, network: receipt.network });
    paid.payment = { amount: p.amount, payTo: p.merchant.payTo, settlement: receipt };
    return paid;
  }

  async function saysAlreadyUsed(res: Response): Promise<boolean> {
    if (res.status !== 402 && res.status !== 409 && res.status !== 400) return false;
    let text = "";
    try {
      const h = res.headers.get(HEADERS.required) ?? res.headers.get("X-PAYMENT-REQUIRED");
      if (h) text += Buffer.from(h, "base64").toString("utf8").slice(0, 4096);
    } catch {
      /* not base64: ignore */
    }
    try {
      text += " " + (await readBodyCapped(res.clone(), 8192) ?? "");
    } catch {
      /* unreadable body */
    }
    return ALREADY_USED.test(text);
  }

  return {
    /**
     * Owner action: forget unconfirmed or paid-but-undelivered payments for a URL, so the next request may sign a new
     * authorization. Use it only after checking the earlier payment yourself. Returns how many entries were cleared.
     */
    forgetUnsettled(url: string): number {
      let n = 0;
      const resource = resourceOf(url);
      for (const [nonce, e] of [...unsettled]) {
        if ((JSON.parse(e.key) as unknown[])[0] === resource) {
          unsettled.delete(nonce);
          n++;
        }
      }
      if (n) audit.append({ type: "payment.forgotten", url, entries: n });
      return n;
    },
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

/** Whether a 402 still offers exactly what a pending authorization pays: same payee, asset, network and amount. */
function sameTerms(required: PaymentRequired, e: Unsettled): boolean {
  return required.accepts.some(
    (r) =>
      r.scheme === e.requirement.scheme &&
      r.network === e.requirement.network &&
      r.asset.toLowerCase() === e.asset.toLowerCase() &&
      r.payTo.toLowerCase() === e.merchant.payTo.toLowerCase() &&
      BigInt(r.amount) === e.amount,
  );
}

/** The origin a 402 says it is for (v2 `resource.url`, or v1's per-option `resource`). A claim, not a key. */
function declaredOrigin(required: PaymentRequired, requirement: PaymentRequirements): string | undefined {
  const r = required.resource ?? requirement.resource;
  const url = typeof r === "string" ? r : r?.url;
  if (!url) return undefined;
  try {
    return new URL(url).origin;
  } catch {
    return "unparseable";
  }
}

/** Largest declaration echoed back per extension (serialized). A bigger one is left out, never truncated. */
const ECHO_MAX_BYTES = 4096;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * The extensions echoed in a v2 payment: only the keys the owner listed for this merchant (Merchant.echoExtensions),
 * each the merchant's own declaration from the 402, plus the owner's builder codes as `builder-code.info.s` (owner
 * codes first, then the merchant's, duplicates removed). Listed keys that are missing, not objects or too large are
 * reported in `skipped`, and the payment goes ahead without them.
 */
function echoedExtensions(required: PaymentRequired, merchant: Merchant): { extensions?: Record<string, unknown>; skipped: string[] } {
  const out: Record<string, unknown> = {};
  const skipped: string[] = [];
  for (const key of merchant.echoExtensions ?? []) {
    const declared = required.extensions?.[key];
    const own = key === "builder-code" ? merchant.builderCodes : undefined;
    if (declared === undefined && !own) {
      skipped.push(key);
      continue;
    }
    if (declared !== undefined && !isPlainObject(declared)) {
      skipped.push(key);
      continue;
    }
    let value: Record<string, unknown> = declared ? (JSON.parse(JSON.stringify(declared)) as Record<string, unknown>) : {};
    if (own) {
      const info = isPlainObject(value.info) ? value.info : {};
      const theirs = Array.isArray(info.s) ? info.s : typeof info.s === "string" ? [info.s] : [];
      value = { ...value, info: { ...info, s: [...new Set([...own, ...theirs.filter((c): c is string => typeof c === "string")])] } };
    }
    if (JSON.stringify(value).length > ECHO_MAX_BYTES) {
      skipped.push(key);
      continue;
    }
    out[key] = value;
  }
  return { ...(Object.keys(out).length > 0 ? { extensions: out } : {}), skipped };
}
