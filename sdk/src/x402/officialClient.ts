import { AsyncLocalStorage } from "node:async_hooks";
import type { AuditLog } from "../guard/audit.js";
import type { ApprovalHook, KillSwitch } from "../guard/controls.js";
import type { SealedPlan } from "../guard/plan.js";
import { evaluate, type PolicyConfig } from "../policy/engine.js";
import type { MerchantRegistry } from "../policy/registry.js";
import type { PaymentRequired } from "./schemas.js";

/** The slice of the official x402 client (`@x402/core` / `@x402/fetch` `x402Client`) the guard hooks into. */
export type HookableX402Client = {
  onBeforePaymentCreation(hook: (ctx: { paymentRequired: unknown; selectedRequirements: unknown }) => Promise<void | { abort: true; reason: string }>): unknown;
  onPaymentCreationFailure(hook: (ctx: { selectedRequirements: unknown; error: Error }) => Promise<void>): unknown;
  onPaymentResponse(hook: (ctx: { requirements: unknown; settleResponse?: { success: boolean }; paymentRequired?: unknown; error?: Error }) => Promise<void>): unknown;
};

export type AgentSafeGuardOptions = {
  registry: MerchantRegistry;
  policy: PolicyConfig;
  /** The session's sealed plan: which merchants, and how much each, for how long. */
  plan: SealedPlan;
  /** Payments above `policy.approvalThreshold` need this to say yes; without it they are refused. */
  approve?: ApprovalHook;
  kill?: KillSwitch;
  audit?: AuditLog;
  now?: () => number;
  /**
   * For clients whose every request goes to one base URL (an OpenAI-style client that wraps its own fetch): the
   * origin payments are judged against when no `guard.fetch` context exists. Owner configuration, never server data.
   */
  origin?: string;
};

type Reservation = { origin: string; amount: bigint; period: number };
type PendingRequest = { url: string; reservations: Reservation[] };

/** The slice of an axios instance `guard.axios` needs (no runtime dependency on axios). */
export type AxiosLike = ((...args: never[]) => Promise<unknown>) & { defaults?: { baseURL?: string | undefined } };
type AxiosConfigLike = { url?: string | undefined; baseURL?: string | undefined } | undefined;
const AXIOS_WITH_DATA = new Set(["post", "put", "patch", "postForm", "putForm", "patchForm"]);
const AXIOS_URL_FIRST = new Set(["get", "delete", "head", "options", ...AXIOS_WITH_DATA]);

/** Axios's URL rule: an absolute URL wins; otherwise baseURL and url are joined with one slash (combineURLs). */
export function axiosUrl(url: unknown, baseURL: string | undefined): string {
  const u = typeof url === "string" ? url : url instanceof URL ? url.href : "";
  if (/^([a-z][a-z\d+\-.]*:)?\/\//i.test(u) || !baseURL) return u;
  return u ? `${baseURL.replace(/\/?\/$/, "")}/${u.replace(/^\/+/, "")}` : baseURL;
}

/**
 * Agent Safe's policy for the official x402 client: install its hooks on an `x402Client`, and wrap the paying fetch so
 * each payment is checked against the origin that was actually requested (the hooks alone only see the 402, whose
 * `resource` is the server's claim about itself).
 *
 * ```ts
 * const guard = agentSafeGuard({ registry, policy, plan });
 * const client = guard.install(x402Client.fromConfig({ schemes: [...] }));
 * const fetchWithPayment = guard.fetch(wrapFetchWithPayment(fetch, client));
 * // or, with @x402/axios:
 * const api = guard.axios(wrapAxiosWithPayment(axios.create(), client));
 * ```
 *
 * Before anything is signed, the 402's chosen option goes through the same `evaluate` as `createAgentPay`: the payee
 * pinned for that origin, the price pin and caps, the asset and network pins, the sealed plan and the period budget.
 * Anything off aborts the payment with the refusal codes in the reason. Budgets are reserved synchronously before the
 * signature and kept unless the facilitator rejected the payment. They live in this process; for a budget shared
 * across processes, and enforced even if the agent's machine is compromised, pair it with a BudgetVault.
 *
 * What stays with the x402 client: retries and settlement. `createAgentPay` additionally never signs twice for one
 * purchase and confirms unreadable receipts on-chain.
 */
export function agentSafeGuard(opts: AgentSafeGuardOptions) {
  const now = opts.now ?? Date.now;
  const requests = new AsyncLocalStorage<PendingRequest>();
  // Reservations made against `opts.origin` (no guard.fetch context), matched to their outcome by amount.
  const fixedPending: Reservation[] = [];
  const ledger = { start: now(), spent: 0n };
  const period = opts.policy.periodBudget;

  const spentInPeriod = (): bigint => {
    if (period && now() - ledger.start >= period.periodMs) {
      ledger.start = now();
      ledger.spent = 0n;
    }
    return ledger.spent;
  };
  const release = (r: Reservation) => {
    opts.plan.release(r.origin, r.amount);
    // Only refund the period the reservation was made in (DFS-01). A rollover resets ledger.spent, so refunding
    // a previous-period reservation into the current counter would under-account the new period's spend.
    spentInPeriod();
    if (r.period === ledger.start) ledger.spent = ledger.spent >= r.amount ? ledger.spent - r.amount : 0n;
  };
  const abort = (url: string, codes: string[], reasons: string[]) => {
    opts.audit?.append({ type: "payment.denied", url, codes, reasons, via: "x402Client" });
    return { abort: true as const, reason: `Agent Safe refused this payment [${codes.join(", ")}]: ${reasons.join("; ")}` };
  };

  /** The reservation a hook's outcome belongs to: this request's latest, or (fixed origin) the oldest of that amount. */
  const take = (requirements: unknown): Reservation | undefined => {
    const ctx = requests.getStore();
    if (ctx) return ctx.reservations.pop();
    const amount = (requirements as { amount?: string } | undefined)?.amount;
    const i = fixedPending.findIndex((r) => amount !== undefined && r.amount === BigInt(amount));
    return i === -1 ? undefined : fixedPending.splice(i, 1)[0];
  };

  return {
    /** Runs every request of the paying fetch with the URL it was made to, which the hooks check payments against. */
    fetch<F extends (input: string | URL | Request, init?: RequestInit) => Promise<Response>>(paying: F): F {
      return ((input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        return requests.run({ url, reservations: [] }, () => paying(input, init));
      }) as F;
    },

    /**
     * The axios counterpart of `guard.fetch`, for `@x402/axios`: returns the instance with every call (`instance(...)`,
     * `request`, `get`, `post`, ...) run with the URL it is made to, resolved against `baseURL` the way axios does.
     *
     * ```ts
     * const api = guard.axios(wrapAxiosWithPayment(axios.create({ baseURL }), guard.install(client)));
     * ```
     */
    axios<A extends AxiosLike>(instance: A): A {
      const run = (config: AxiosConfigLike | undefined, url: unknown, call: () => unknown) =>
        requests.run({ url: axiosUrl(url ?? config?.url, config?.baseURL ?? instance.defaults?.baseURL), reservations: [] }, call);
      return new Proxy(instance, {
        apply(target, thisArg, args: unknown[]) {
          const [a, b] = args as [unknown, AxiosConfigLike | undefined];
          return typeof a === "string" ? run(b, a, () => Reflect.apply(target, thisArg, args)) : run(a as AxiosConfigLike, undefined, () => Reflect.apply(target, thisArg, args));
        },
        get(target, prop, receiver) {
          const value = Reflect.get(target, prop, receiver);
          if (typeof value !== "function" || typeof prop !== "string") return value;
          if (prop === "request") return (config: AxiosConfigLike) => run(config, undefined, () => value.call(target, config));
          if (AXIOS_URL_FIRST.has(prop)) {
            return (url: string, ...rest: unknown[]) => {
              const config = (AXIOS_WITH_DATA.has(prop) ? rest[1] : rest[0]) as AxiosConfigLike | undefined;
              return run(config, url, () => value.call(target, url, ...rest));
            };
          }
          return value;
        },
      }) as A;
    },

    /** Registers the guard's hooks on an x402 client and returns the client. */
    install<C extends HookableX402Client>(client: C): C {
      client.onBeforePaymentCreation(async ({ paymentRequired, selectedRequirements }) => {
        const ctx = requests.getStore();
        const url = ctx?.url ?? opts.origin;
        if (!url) return abort("(unknown)", ["unknown_merchant"], ["the paying client is not wrapped with guard.fetch or guard.axios, so the requested origin is unknown"]);
        try {
          opts.kill?.assertAlive();
        } catch (e) {
          return abort(url, ["kill_switch"], [String((e as Error).message ?? e).slice(0, 120)]);
        }
        const declared = paymentRequired as { x402Version?: number };
        // Only the option the client is about to sign is judged, exactly as it would be signed.
        const required = { x402Version: declared.x402Version, accepts: [selectedRequirements] } as unknown as PaymentRequired;
        let decision: ReturnType<typeof evaluate>;
        try {
          decision = evaluate(opts.policy, opts.registry, { url, required, plan: opts.plan, spentInPeriod: spentInPeriod(), now: now() });
        } catch (e) {
          const reason = String((e as Error)?.message ?? e).slice(0, 200);
          return abort(url, [reason.startsWith("refusing non-https origin") ? "unknown_merchant" : "policy_denied"], [reason]);
        }
        if (decision.kind === "deny") return abort(url, decision.codes, decision.reasons);
        const { merchant, amount } = decision;
        // Reserve before any await, so concurrent payments can't all pass the same check.
        if (!opts.plan.reserve(merchant.origin, amount)) return abort(url, ["plan_exhausted"], ["amount exceeds what is left in the sealed plan"]);
        if (period && spentInPeriod() + amount > period.amount) {
          opts.plan.release(merchant.origin, amount);
          return abort(url, ["budget_exhausted"], ["amount exceeds the period budget"]);
        }
        ledger.spent += amount;
        const reservation = { origin: merchant.origin, amount, period: ledger.start };
        if (decision.kind === "needsApproval") {
          const ok = opts.approve ? await opts.approve({ origin: merchant.origin, payTo: merchant.payTo, amount, network: merchant.network, reasons: decision.reasons }).catch(() => false) : false;
          if (!ok) {
            release(reservation);
            opts.audit?.append({ type: "payment.approval_refused", origin: merchant.origin, amount });
            return { abort: true, reason: `Agent Safe refused this payment [approval_required]: ${decision.reasons.join("; ")}` };
          }
        }
        (ctx ? ctx.reservations : fixedPending).push(reservation);
        opts.audit?.append({ type: "payment.signed", origin: merchant.origin, payTo: merchant.payTo, amount, via: "x402Client" });
      });

      // Nothing was signed: give the budget back.
      client.onPaymentCreationFailure(async ({ selectedRequirements }) => {
        const r = take(selectedRequirements);
        if (r) release(r);
      });

      client.onPaymentResponse(async ({ requirements, settleResponse, paymentRequired }) => {
        const r = take(requirements);
        if (!r) return;
        if (settleResponse?.success) opts.audit?.append({ type: "payment.settled", origin: r.origin, amount: r.amount, via: "x402Client" });
        // Rejected at verification: the authorization was not used, so its budget comes back. A failed settlement or a
        // transport error may still have paid: that budget stays spent.
        else if (!settleResponse && paymentRequired) release(r);
      });
      return client;
    },
  };
}
