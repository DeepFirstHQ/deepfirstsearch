import { decodeHeader, X402DecodeError } from "./codec.js";
import {
  caip2ToV1Network,
  HEADERS,
  PaymentRequiredV1,
  SettleResponseV1,
  v1NetworkToCaip2,
  type PaymentPayloadV1,
  type PaymentRequired,
  type PaymentRequirements,
  type SettleResponse,
} from "./schemas.js";

/** Cap on a v1 402 body (v1 sends the 402 as JSON in the body, not in a header). Real ones are 2 to 3 KiB. */
export const MAX_V1_BODY_BYTES = 32 * 1024;

/** Server-controlled values appear in reasons only as short, plain tokens (SDK-L-3). */
function show(v: unknown): string {
  const t = String(v).replace(/[^A-Za-z0-9:._-]/g, "").slice(0, 42);
  return t.length ? t : "(invalid)";
}

/**
 * Reads at most `limit` bytes of a response body. Returns undefined when the body is larger (the rest is not read).
 */
export async function readBodyCapped(res: Response, limit = MAX_V1_BODY_BYTES): Promise<string | undefined> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) {
    await res.body?.cancel().catch(() => {});
    return undefined;
  }
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => {});
      return undefined;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** True when a parsed JSON value claims to be an x402 v1 402 (only a hint: it is strictly parsed afterwards). */
export function looksLikeV1(json: unknown): boolean {
  return typeof json === "object" && json !== null && (json as { x402Version?: unknown }).x402Version === 1;
}

export function parseV1(json: unknown): PaymentRequiredV1 {
  const parsed = PaymentRequiredV1.safeParse(json);
  if (!parsed.success) throw new X402DecodeError(`invalid x402 v1 402: ${parsed.error.issues[0]?.message ?? "schema"}`);
  return parsed.data;
}

/**
 * Turns a v1 402 into the internal (v2-shaped) form the policy reads, keeping `x402Version: 1`. Network names are
 * mapped through the fixed table only; options on any other network are dropped with a reason. Only the fields the
 * policy acts on are carried over: resource metadata and outputSchema are left behind.
 */
export function normalizeV1(v1: PaymentRequiredV1): { required: PaymentRequired; skipped: string[] } {
  const accepts: PaymentRequirements[] = [];
  const skipped: string[] = [];
  for (const o of v1.accepts) {
    const network = v1NetworkToCaip2(o.network);
    if (!network) {
      skipped.push(`x402 v1 network ${show(o.network)} is not supported`);
      continue;
    }
    accepts.push({
      scheme: o.scheme,
      network,
      amount: o.maxAmountRequired,
      asset: o.asset,
      payTo: o.payTo,
      maxTimeoutSeconds: o.maxTimeoutSeconds,
      ...(o.extra ? { extra: o.extra } : {}),
    });
  }
  return { required: { x402Version: 1, accepts }, skipped };
}

/** The v1 `X-PAYMENT` payload for an approved (normalized) requirement. */
export function v1Payload(requirement: PaymentRequirements, payload: PaymentPayloadV1["payload"]): PaymentPayloadV1 {
  const network = caip2ToV1Network(requirement.network);
  if (!network || requirement.scheme !== "exact") throw new Error("requirement is not an x402 v1 exact option"); // unreachable after the policy
  return { x402Version: 1, scheme: "exact", network, payload };
}

/**
 * Reads a v1 receipt (`X-PAYMENT-RESPONSE`, or `PAYMENT-RESPONSE` as the reference client also accepts) with the same
 * size cap and strictness as v2. The network is reported as CAIP-2 when it is in the fixed table; any other value
 * is returned as received so the caller's network comparison fails.
 */
export function decodeV1Receipt(headers: Headers): SettleResponse {
  const r = decodeHeader(headers.get(HEADERS.legacyResponse) ?? headers.get(HEADERS.response), SettleResponseV1);
  return { ...r, network: r.network.includes(":") ? r.network : (v1NetworkToCaip2(r.network) ?? r.network) };
}
