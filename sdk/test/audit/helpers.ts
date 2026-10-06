import { createAgentPay, type AgentPayOptions } from "../../src/x402/client.js";
import { MerchantRegistry, type Merchant } from "../../src/policy/registry.js";
import { decodeHeader, encodeHeader } from "../../src/x402/codec.js";
import { PaymentPayload, type PaymentRequired, type PaymentRequirements } from "../../src/x402/schemas.js";
import { MERCHANT_PAYTO, NETWORK, ORIGIN, payer, policy, requirement } from "../fixtures.js";

export type Sent = { url: string; init: RequestInit; payload?: PaymentPayload };

/** Builds a Response whose read-only `url` / `redirected` fields are set like a real fetch would. */
export function resp(status: number, headers: Record<string, string> = {}, url = "", redirected = false): Response {
  const r = new Response(status === 204 ? null : "body", { status, headers });
  Object.defineProperty(r, "url", { value: url });
  Object.defineProperty(r, "redirected", { value: redirected });
  return r;
}

export const ok = (extra: Partial<{ success: boolean; errorReason: string }> = {}) =>
  encodeHeader({ success: true, transaction: "0x" + "ab".repeat(32), network: NETWORK, ...extra });

export function req402(accepts: PaymentRequirements[] = [requirement()], extra: Partial<PaymentRequired> = {}) {
  return { "PAYMENT-REQUIRED": encodeHeader({ x402Version: 2, accepts, ...extra }) };
}

/**
 * Scriptable fake network. `onFirst` answers an unpaid request, `onPaid` a request carrying PAYMENT-SIGNATURE.
 * Every signed payload that leaves the SDK is captured in `signed`.
 */
export function fakeNet(opts: {
  onFirst?: (url: string) => Response | Promise<Response>;
  onPaid?: (url: string, p: PaymentPayload) => Response | Promise<Response>;
} = {}) {
  const sent: Sent[] = [];
  const signed: PaymentPayload[] = [];
  const f = (async (input: string, init: RequestInit = {}) => {
    const h = new Headers(init.headers);
    const sig = h.get("PAYMENT-SIGNATURE");
    if (sig) {
      const p = decodeHeader(sig, PaymentPayload);
      signed.push(p);
      sent.push({ url: input, init, payload: p });
      return (opts.onPaid ?? (() => resp(200, { "PAYMENT-RESPONSE": ok() }, input)))(input, p);
    }
    sent.push({ url: input, init });
    return (opts.onFirst ?? (() => resp(402, req402(), input)))(input);
  }) as unknown as typeof fetch;
  return { fetch: f, sent, signed };
}

export const safeSession = { readsUntrustedInput: true, accessesSensitiveData: false, canPay: true };

export function mkPay(
  net: { fetch: typeof fetch },
  o: Partial<AgentPayOptions> & { merchant?: Partial<Merchant>; planMax?: bigint } = {},
) {
  const m: Merchant = { origin: ORIGIN, payTo: MERCHANT_PAYTO, network: NETWORK, maxPerTx: 1_000_000n, pricePin: 10_000n, ...o.merchant };
  const registry = o.registry ?? new MerchantRegistry([m]);
  const pay = createAgentPay({ registry, policy, payer: () => payer, session: safeSession, fetch: net.fetch, settleRetryDelayMs: 1, ...o } as AgentPayOptions);
  const plan = pay.commitPlan([{ origin: m.origin, maxSpend: o.planMax ?? 30_000n }], 3_600_000);
  return { pay, plan, registry };
}
