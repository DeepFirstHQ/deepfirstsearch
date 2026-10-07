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
  if (r.maxAmountRequired !== undefined && r.maxAmountRequired !== r.amount) ctx.addIssue({ code: "custom", path: ["maxAmountRequired"], message: "legacy maxAmountRequired disagrees with amount" });
  if (!r.network.startsWith("eip155:")) return;
  for (const k of ["asset", "payTo"] as const) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(r[k])) ctx.addIssue({ code: "custom", path: [k], message: "expected a 20-byte hex address" });
  }
});
export type PaymentRequirements = z.infer<typeof PaymentRequirements>;

export const PaymentRequired = z.strictObject({
  x402Version: z.number().int(),
  error: z.string().max(1024).optional(),
  resource: ResourceInfo.optional(),
  accepts: z.array(PaymentRequirements).max(16),
  // Extensions (e.g. Bazaar) are accepted on input but never echoed back: they only leak metadata. The resource is.
  extensions: z.record(z.string(), z.unknown()).optional(),
});
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
  network: caip2,
  amount: atomic.nullish(),
  errorReason: z.string().max(512).nullish(), // some facilitators send null on success
});
export type SettleResponse = z.infer<typeof SettleResponse>;

export const HEADERS = {
  required: "PAYMENT-REQUIRED",
  signature: "PAYMENT-SIGNATURE",
  response: "PAYMENT-RESPONSE",
  // x402 v1 name; some live merchants (e.g. BlockRun, October 2026) still send the receipt under it.
  legacyResponse: "X-PAYMENT-RESPONSE",
} as const;
