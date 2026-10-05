/**
 * Provenance tagging. Anything that came from outside the owner's configuration is wrapped in `Tainted<T>`.
 * Tainted values can be read and shown, but the policy engine never accepts them as a payee, an amount or a
 * network. The only way to turn a tainted value into a trusted one is an exact match against owner-configured
 * data (see `MerchantRegistry.resolve`).
 */
export type Source = "owner" | "config" | "user" | "web" | "merchant" | "model";

declare const brand: unique symbol;

export type Tainted<T> = {
  readonly value: T;
  readonly source: Source;
  readonly [brand]: true;
};

export function taint<T>(value: T, source: Source): Tainted<T> {
  return Object.freeze({ value, source }) as Tainted<T>;
}

export const TRUSTED_SOURCES: ReadonlySet<Source> = new Set(["owner", "config"]);

export function isTrusted(t: Tainted<unknown>): boolean {
  return TRUSTED_SOURCES.has(t.source);
}
