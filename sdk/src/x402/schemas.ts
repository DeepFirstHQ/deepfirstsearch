import { z } from "zod";

// x402 v2 wire types (github.com/x402-foundation/x402, specs/x402-specification-v2.md).
// Every schema is strict: unknown fields from a server are rejected, not ignored.

const hexAddress = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "expected a 20-byte hex address");
const hex32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/, "expected 32 bytes of hex");
const atomic = z.string().regex(/^[0-9]{1,78}$/, "expected an atomic integer amount");
const caip2 = z.string().regex(/^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}$/, "expected a CAIP-2 network id");

export const ResourceInfo = z.strictObject({
  url: z.string().max(2048),
  description: z.string().max(1024).optional(),
  mimeType: z.string().max(128).optional(),
});

export const PaymentRequirements = z.strictObject({
  scheme: z.string().max(32),
  network: caip2,
  amount: atomic,
  asset: hexAddress,
  payTo: hexAddress,
  maxTimeoutSeconds: z.number().int().nonnegative(),
  extra: z
    .strictObject({
      name: z.string().max(64).optional(),
      version: z.string().max(16).optional(),
      assetTransferMethod: z.string().max(32).optional(),
    })
    .optional(),
});
export type PaymentRequirements = z.infer<typeof PaymentRequirements>;

export const PaymentRequired = z.strictObject({
  x402Version: z.number().int(),
  error: z.string().max(1024).optional(),
  resource: ResourceInfo.optional(),
  accepts: z.array(PaymentRequirements).max(16),
  // Extensions (e.g. Bazaar) are accepted on input but never echoed back: they only leak metadata.
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
  payer: hexAddress.optional(),
  transaction: z.string().max(256),
  network: caip2,
  amount: atomic.optional(),
  errorReason: z.string().max(512).optional(),
});
export type SettleResponse = z.infer<typeof SettleResponse>;

export const HEADERS = {
  required: "PAYMENT-REQUIRED",
  signature: "PAYMENT-SIGNATURE",
  response: "PAYMENT-RESPONSE",
} as const;
