import { getAddress, isAddress, type Address } from "viem";
import { PINNED_USDC } from "@deepfirstsearch/agent-pay";

// Kept identical in every payer package (each is published on its own): change one, change them all.

/** EIP-3009 `TransferWithAuthorization`, field by field: the only struct an x402 payer signs. */
const TRANSFER_FIELDS = [
  ["from", "address"],
  ["to", "address"],
  ["value", "uint256"],
  ["validAfter", "uint256"],
  ["validBefore", "uint256"],
  ["nonce", "bytes32"],
] as const;
/** The standard EIP-712 domain for USDC; accepted if a caller spells it out, since it then decides the domain hash. */
const DOMAIN_FIELDS = [
  ["name", "string"],
  ["version", "string"],
  ["chainId", "uint256"],
  ["verifyingContract", "address"],
] as const;

const sameFields = (actual: unknown, expected: readonly (readonly [string, string])[]) =>
  Array.isArray(actual) &&
  actual.length === expected.length &&
  actual.every((f, i) => f?.name === expected[i]![0] && f?.type === expected[i]![1] && Object.keys(f).length === 2);

/**
 * Throws unless `typedData` is an EIP-3009 `TransferWithAuthorization` from `payer`, on the pinned USDC contract of its
 * chain (`PINNED_USDC`, Base or Base Sepolia) with that contract's own EIP-712 domain. Checked before the signer is
 * asked, so whoever holds the payer can't get it to sign a USDC `Permit`, an order on another protocol, or any other
 * typed data, even when the request does not come through the SDK.
 */
export function assertPaymentAuthorization(typedData: unknown, payer: Address): void {
  const refuse = (why: string): never => {
    throw new Error(`refusing to sign: ${why}; this payer only signs EIP-3009 TransferWithAuthorization for pinned USDC`);
  };
  const td = (typedData ?? {}) as { domain?: Record<string, unknown>; types?: Record<string, unknown>; primaryType?: unknown; message?: Record<string, unknown> };
  if (td.primaryType !== "TransferWithAuthorization") refuse(`primaryType is ${JSON.stringify(td.primaryType)}`);

  const types = td.types ?? {};
  if (Object.keys(types).some((k) => k !== "TransferWithAuthorization" && k !== "EIP712Domain")) refuse("unexpected types");
  if (!sameFields(types.TransferWithAuthorization, TRANSFER_FIELDS)) refuse("TransferWithAuthorization fields differ from EIP-3009");
  if ("EIP712Domain" in types && !sameFields(types.EIP712Domain, DOMAIN_FIELDS)) refuse("non-standard EIP712Domain");

  const domain = td.domain ?? {};
  if (Object.keys(domain).some((k) => !DOMAIN_FIELDS.some(([name]) => name === k))) refuse("unexpected domain fields");
  const chainId = domain.chainId;
  const pin = typeof chainId === "number" || typeof chainId === "bigint" ? PINNED_USDC[`eip155:${chainId}`] : undefined;
  if (!pin) refuse(`chainId ${String(chainId)} has no pinned USDC`);
  const contract = domain.verifyingContract;
  if (typeof contract !== "string" || !isAddress(contract, { strict: false }) || getAddress(contract) !== getAddress(pin!.asset))
    refuse(`verifyingContract is not USDC on chain ${String(chainId)}`);
  if (domain.name !== pin!.domain.name || domain.version !== pin!.domain.version) refuse("domain name or version is not USDC's");

  const from = td.message?.from;
  if (typeof from !== "string" || !isAddress(from, { strict: false }) || getAddress(from) !== getAddress(payer))
    refuse("authorization is not from this payer");
}
