import { z } from "zod";

// x402 v2 wire types (github.com/x402-foundation/x402, specs/x402-specification-v2.md).
// Schemas are strict (unknown fields from a server are rejected), except `extra`, which the spec leaves free-form.

const hexAddress = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "expected a 20-byte hex address");
const hex32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/, "expected 32 bytes of hex");
const atomic = z.string().regex(/^[0-9]{1,78}$/, "expected an atomic integer amount");
const caip2 = z.string().regex(/^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}$/, "expected a CAIP-2 network id");

// Loose: Bazaar-style 402s add metadata (serviceName, tags, iconUrl). It is echoed back to the server as received.
export const ResourceInfo = z.looseObject({
  url: z.string().max(2048),
  description: z.string().max(1024).optional(),
  mimeType: z.string().max(128).optional(),
});

// Merchants list options for several chains in one 402 (Exa offers Base and Solana). Addresses are only checked as
// EVM addresses on eip155 networks; other chains' options parse and are then skipped by the policy.
const chainAddress = z.string().min(1).max(128);
export const PaymentRequirements = z.strictObject({
  scheme: z.string().max(32),
  network: caip2,
  amount: atomic,
  asset: chainAddress,
  payTo: chainAddress,
  maxTimeoutSeconds: z.number().int().nonnegative(),
  // x402 v1 aliases some servers still send next to the v2 fields (OneSource). Accepted only when they agree.
  currency: chainAddress.optional(),
  maxAmountRequired: atomic.optional(),
  recipient: chainAddress.optional(),
  // x402 v1 kept the resource's metadata in each requirement; some v2 servers still repeat it there (Interzoid).
  // Informational only: no payment decision reads them; `accepted` echoes them back as received, like the rest.
  resource: z.union([z.string().max(2048), ResourceInfo]).optional(),
  description: z.string().max(1024).optional(),
  mimeType: z.string().max(128).optional(),
  // More informational fields some v2 servers repeat per option (Automaton Sovereign): Bazaar's outputSchema, and the
  // network again as a chain id and as a v1 name. Never read for a decision; chainId and networkV1 must agree with
  // `network` or the whole 402 is rejected, so they can't be used to confuse anyone downstream.
  outputSchema: z.unknown().optional(),
  chainId: z.number().int().positive().optional(),
  networkV1: z.string().max(32).optional(),
  // `extra` is scheme-specific and free-form in the spec (merchants add pricing breakdowns, ids, gateway data), so
  // unknown keys are kept, not rejected. The fields we act on stay typed, and none of them is ever used to sign:
  // the EIP-712 domain comes from our own pins. The header size limit bounds what extra can carry.
  extra: z
    .looseObject({
      name: z.string().max(64).optional(),
      version: z.string().max(16).optional(),
      assetTransferMethod: z.string().max(32).optional(),
    })
    .optional(),
}).superRefine((r, ctx) => {
  const same = (a: string | undefined, b: string) => a === undefined || a.toLowerCase() === b.toLowerCase();
  if (!same(r.currency, r.asset)) ctx.addIssue({ code: "custom", path: ["currency"], message: "legacy currency disagrees with asset" });
  if (!same(r.recipient, r.payTo)) ctx.addIssue({ code: "custom", path: ["recipient"], message: "legacy recipient disagrees with payTo" });
  const chainOf = (caip: string) => (/^eip155:(\d+)$/.exec(caip)?.[1] ?? "");
  if (r.chainId !== undefined && String(r.chainId) !== chainOf(r.network)) ctx.addIssue({ code: "custom", path: ["chainId"], message: "chainId disagrees with network" });
  if (r.networkV1 !== undefined && v1NetworkToCaip2(r.networkV1) !== r.network) ctx.addIssue({ code: "custom", path: ["networkV1"], message: "networkV1 disagrees with network" });
  if (r.maxAmountRequired !== undefined && r.maxAmountRequired !== r.amount) ctx.addIssue({ code: "custom", path: ["maxAmountRequired"], message: "legacy maxAmountRequired disagrees with amount" });
  if (!r.network.startsWith("eip155:")) return;
  for (const k of ["asset", "payTo"] as const) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(r[k])) ctx.addIssue({ code: "custom", path: [k], message: "expected a 20-byte hex address" });
  }
});
export type PaymentRequirements = z.infer<typeof PaymentRequirements>;

// Top level: vendor keys (instructions, trial info, legacy copies, e.g. Automaton Sovereign) are dropped, never read or
// echoed. Keys that look like payment terms are still rejected, so a stray top-level payTo or amount can't confuse
// anyone reading the 402. Each payment option below stays strict, since that is where every decision is made. The
// header size limit bounds what a 402 can carry.
const PAYMENT_TERM_KEYS = ["payTo", "pay_to", "to", "recipient", "amount", "maxAmountRequired", "asset", "currency", "network", "scheme", "price", "value"];
export const PaymentRequired = z
  .looseObject({
    x402Version: z.number().int(),
    error: z.string().max(1024).optional(),
    resource: ResourceInfo.optional(),
    accepts: z.array(PaymentRequirements).max(16),
    // Extensions (e.g. Bazaar) are accepted on input but never echoed back: they only leak metadata. The resource is.
    extensions: z.record(z.string(), z.unknown()).optional(),
  })
  .superRefine((r, ctx) => {
    for (const k of PAYMENT_TERM_KEYS) {
      if (Object.prototype.hasOwnProperty.call(r, k)) ctx.addIssue({ code: "custom", path: [k], message: `payment term "${k}" outside accepts` });
    }
  })
  .transform(({ x402Version, error, resource, accepts, extensions }) => ({
    x402Version,
    ...(error !== undefined ? { error } : {}),
    ...(resource !== undefined ? { resource } : {}),
    accepts,
    ...(extensions !== undefined ? { extensions } : {}),
  }));
export type PaymentRequired = z.infer<typeof PaymentRequired>;

export const Authorization = z.strictObject({
  from: hexAddress,
  to: hexAddress,
  value: atomic,
  validAfter: atomic,
  validBefore: atomic,
  nonce: hex32,
});
export type Authorization = z.infer<typeof Authorization>;

export const PaymentPayload = z.strictObject({
  x402Version: z.literal(2),
  // The 402's resource, echoed as the spec's clients do; facilitators such as Coinbase's reject payloads without it.
  resource: ResourceInfo.optional(),
  accepted: PaymentRequirements,
  payload: z.strictObject({
    signature: z.string().regex(/^0x[0-9a-fA-F]+$/),
    authorization: Authorization,
  }),
});
export type PaymentPayload = z.infer<typeof PaymentPayload>;

// The settlement receipt is parsed leniently (unknown fields are dropped): it arrives after the money moved, so
// a newer facilitator adding a field must not make a completed payment look failed. Requests stay strict.
export const SettleResponse = z.object({
  success: z.boolean(),
  payer: hexAddress.nullish(),
  transaction: z.string().max(256),
  // CAIP-2, or a v1 short name from the fixed table (some v2 servers still write "base" here, e.g. Automaton
  // Sovereign's origin): normalised to CAIP-2, so the "settled on the network we signed" check still applies.
  network: z.union([caip2, z.string().max(32).refine((n) => v1NetworkToCaip2(n) !== undefined, "unknown network")]).transform((n) => v1NetworkToCaip2(n) ?? n),
  amount: atomic.nullish(),
  errorReason: z.string().max(512).nullish(), // some facilitators send null on success
});
export type SettleResponse = z.infer<typeof SettleResponse>;

// ---------------------------------------------------------------------------------------------------------------
// x402 v1 (opt-in per merchant, see Merchant.x402Versions). v1 sends the 402 as a JSON body, names networks with
// short names instead of CAIP-2, puts the price in `maxAmountRequired`, and exchanges `X-PAYMENT` /
// `X-PAYMENT-RESPONSE`. Field names follow the reference client (coinbase/x402, @x402/core types/v1 and
// @x402/evm exact/v1/client). A v1 402 is normalized into the v2 shape above and then goes through the same policy.

/**
 * The only v1 network names we understand, mapped to CAIP-2 by a fixed table (never derived from the server).
 * Any other name (solana, polygon, typos...) is not a payable option.
 */
export const V1_NETWORKS: Readonly<Record<string, `eip155:${number}`>> = Object.freeze({
  base: "eip155:8453",
  "base-sepolia": "eip155:84532",
});

/** CAIP-2 id for a v1 network name, or undefined when the name is not in the fixed table. */
export function v1NetworkToCaip2(name: string): `eip155:${number}` | undefined {
  return Object.prototype.hasOwnProperty.call(V1_NETWORKS, name) ? V1_NETWORKS[name] : undefined;
}

/** v1 name for a CAIP-2 id in the fixed table, or undefined. */
export function caip2ToV1Network(caip2Id: string): string | undefined {
  return Object.keys(V1_NETWORKS).find((k) => V1_NETWORKS[k] === caip2Id);
}

const v1Network = z.string().regex(/^[a-z0-9][-a-z0-9]{0,31}$/, "expected a v1 network name");

export const PaymentRequirementsV1 = z.strictObject({
  scheme: z.string().max(32),
  network: v1Network,
  maxAmountRequired: atomic,
  // Resource metadata, informational only (a v1 payment payload does not echo it).
  resource: z.string().max(2048).optional(),
  description: z.string().max(2048).optional(),
  mimeType: z.string().max(128).optional(),
  // Bazaar-style input/output description. Informational only; never read, never echoed back.
  outputSchema: z.record(z.string(), z.unknown()).nullish(),
  payTo: chainAddress,
  maxTimeoutSeconds: z.number().int().nonnegative(),
  asset: chainAddress,
  // Same rules as v2: free-form, the typed fields are checked against the pins, nothing in it is used to sign.
  extra: z
    .looseObject({
      name: z.string().max(64).optional(),
      version: z.string().max(16).optional(),
      assetTransferMethod: z.string().max(32).optional(),
    })
    .nullish(),
}).superRefine((r, ctx) => {
  if (v1NetworkToCaip2(r.network) === undefined) return; // not payable; the policy skips it
  for (const k of ["asset", "payTo"] as const) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(r[k])) ctx.addIssue({ code: "custom", path: [k], message: "expected a 20-byte hex address" });
  }
});
export type PaymentRequirementsV1 = z.infer<typeof PaymentRequirementsV1>;

export const PaymentRequiredV1 = z.strictObject({
  x402Version: z.literal(1),
  error: z.string().max(1024).optional(),
  accepts: z.array(PaymentRequirementsV1).max(16),
  // Browserbase repeats its EVM payee here. Informational only, accepted only when it agrees with an EVM option.
  payToAddress: hexAddress.optional(),
}).superRefine((r, ctx) => {
  if (r.payToAddress === undefined) return;
  const evm = r.accepts.filter((a) => v1NetworkToCaip2(a.network) !== undefined);
  if (!evm.some((a) => a.payTo.toLowerCase() === r.payToAddress!.toLowerCase())) {
    ctx.addIssue({ code: "custom", path: ["payToAddress"], message: "payToAddress disagrees with the offered payTo" });
  }
});
export type PaymentRequiredV1 = z.infer<typeof PaymentRequiredV1>;

/** The v1 `X-PAYMENT` payload: no `accepted`, no `resource`; scheme and v1 network name at the top level. */
export const PaymentPayloadV1 = z.strictObject({
  x402Version: z.literal(1),
  scheme: z.literal("exact"),
  network: v1Network,
  payload: z.strictObject({
    signature: z.string().regex(/^0x[0-9a-fA-F]+$/),
    authorization: Authorization,
  }),
});
export type PaymentPayloadV1 = z.infer<typeof PaymentPayloadV1>;

// v1 receipt (`X-PAYMENT-RESPONSE`): same leniency and bounds as SettleResponse, except the network is a v1 name.
// A CAIP-2 id is tolerated too. The client maps it through the fixed table and compares it with what was signed.
export const SettleResponseV1 = z.object({
  success: z.boolean(),
  payer: hexAddress.nullish(),
  transaction: z.string().max(256),
  network: z.union([v1Network, caip2]),
  amount: atomic.nullish(),
  errorReason: z.string().max(512).nullish(),
});
export type SettleResponseV1 = z.infer<typeof SettleResponseV1>;

export const HEADERS = {
  required: "PAYMENT-REQUIRED",
  signature: "PAYMENT-SIGNATURE",
  response: "PAYMENT-RESPONSE",
  // x402 v1 name; some live merchants (e.g. BlockRun, October 2026) still send the receipt under it.
  legacyResponse: "X-PAYMENT-RESPONSE",
  /** x402 v1 request header carrying the signed payment (opt-in merchants only). */
  v1Signature: "X-PAYMENT",
} as const;
