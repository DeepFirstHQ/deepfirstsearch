import type { z } from "zod";

/** Hard cap on any x402 header we parse; a hostile server cannot make us decode megabytes. */
// Bazaar-style 402s with input/output schemas run past 8 KiB (Otto sends ~10 KiB).
export const MAX_HEADER_BYTES = 16 * 1024;

export class X402DecodeError extends Error {
  override name = "X402DecodeError";
}

export function encodeHeader(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

/** Decodes a base64 JSON header and validates it against a strict schema. */
export function decodeHeader<S extends z.ZodType>(raw: string | null, schema: S): z.infer<S> {
  if (raw === null) throw new X402DecodeError("missing header");
  if (raw.length > MAX_HEADER_BYTES) throw new X402DecodeError("header too large");
  if (!/^[A-Za-z0-9+/=_-]+$/.test(raw)) throw new X402DecodeError("header is not base64");
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
  } catch {
    throw new X402DecodeError("header is not base64 JSON");
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw new X402DecodeError(`invalid header: ${parsed.error.issues[0]?.message ?? "schema"}`);
  return parsed.data;
}
