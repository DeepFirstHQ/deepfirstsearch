/**
 * The slice of the x402 wire format the scanner needs, hand-rolled with zero dependencies so the tool stays light and
 * standalone. A 402 carries its payment terms as base64 JSON in a `PAYMENT-REQUIRED` header (and, for clients that
 * read the body, as `{ accepts: [...] }`). A buyer answers with base64 JSON in `PAYMENT-SIGNATURE` (x402 v2) or
 * `X-PAYMENT` (v1). This matches what live clients produce; the scanner inspects what they sign, never the chain.
 */

export const USDC = {
  "eip155:8453": "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", // Base mainnet
  "eip155:84532": "0x036cbd53842c5426634e7929541ec2318f3dcf7e", // Base Sepolia
} as const;

export type Requirement = {
  scheme: string;
  network: string;
  asset: string;
  payTo: string;
  /** Atomic units, as a decimal string. */
  amount?: string;
  maxAmountRequired?: string;
  maxTimeoutSeconds?: number;
  extra?: Record<string, unknown>;
};

export type PaymentRequired = {
  x402Version: number;
  resource?: { url: string };
  accepts: Requirement[];
};

/** An EIP-3009 TransferWithAuthorization message, as a buyer signs it. */
export type Authorization = {
  from?: string;
  to?: string;
  value?: string;
  validAfter?: string;
  validBefore?: string;
  nonce?: string;
};

export type SignedPayment = {
  /** The typed-data primary type the buyer signed, when it can be told apart (`TransferWithAuthorization` or `Permit`). */
  primaryType: "TransferWithAuthorization" | "Permit" | "unknown";
  authorization: Authorization;
  /** For a Permit: the owner-signed approval fields (spender, value, deadline). */
  permit?: { owner?: string; spender?: string; value?: string; deadline?: string };
  network?: string;
  raw: unknown;
};

const b64 = {
  enc: (s: string) => Buffer.from(s, "utf8").toString("base64"),
  dec: (s: string) => Buffer.from(s, "base64").toString("utf8"),
};

/** Encodes a 402's terms as the `PAYMENT-REQUIRED` header value (base64 JSON). */
export function encodeRequiredHeader(required: PaymentRequired): string {
  return b64.enc(JSON.stringify(required));
}

/** Reads what a buyer signed from a `PAYMENT-SIGNATURE` / `X-PAYMENT` header value. Never throws. */
export function decodePayment(headerValue: string): SignedPayment | null {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(b64.dec(headerValue));
  } catch {
    try {
      obj = JSON.parse(headerValue);
    } catch {
      return null;
    }
  }
  const payload = (obj.payload ?? obj) as Record<string, unknown>;
  const message = (payload.authorization ?? payload.message ?? payload) as Record<string, unknown>;
  const network = typeof obj.network === "string" ? obj.network : undefined;
  // A Permit names an owner/spender and a (usually unlimited) value; a transfer names from/to.
  if (message && ("spender" in message || message.primaryType === "Permit" || obj.primaryType === "Permit")) {
    return {
      primaryType: "Permit",
      authorization: {},
      permit: { owner: str(message.owner), spender: str(message.spender), value: str(message.value), deadline: str(message.deadline) },
      ...(network ? { network } : {}),
      raw: obj,
    };
  }
  if (message && ("to" in message || "from" in message)) {
    return {
      primaryType: "TransferWithAuthorization",
      authorization: { from: str(message.from), to: str(message.to), value: str(message.value), validAfter: str(message.validAfter), validBefore: str(message.validBefore), nonce: str(message.nonce) },
      ...(network ? { network } : {}),
      raw: obj,
    };
  }
  return { primaryType: "unknown", authorization: {}, ...(network ? { network } : {}), raw: obj };
}

function str(v: unknown): string | undefined {
  return v === undefined || v === null ? undefined : String(v);
}

export const sameAddress = (a?: string, b?: string): boolean => !!a && !!b && a.toLowerCase() === b.toLowerCase();
