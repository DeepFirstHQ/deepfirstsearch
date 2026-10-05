import { secp256k1 } from "@noble/curves/secp256k1.js";
import { bytesToHex, hexToBytes, keccak256, type Address, type Hex } from "viem";
import { publicKeyToAddress } from "viem/accounts";

/**
 * ERC-5564 stealth addresses, scheme 1 (secp256k1, with view tags).
 * A merchant publishes one meta-address; payers derive a fresh one-time address for every payment, and only the
 * merchant can find and spend those payments. Used for the payee side and, later, for shielded-pool withdrawals.
 */
const Point = secp256k1.Point;
const N = Point.Fn.ORDER;

export type StealthMetaAddress = `st:eth:0x${string}`;

export function encodeMetaAddress(spendingPublicKey: Uint8Array, viewingPublicKey: Uint8Array): StealthMetaAddress {
  return `st:eth:${bytesToHex(spendingPublicKey)}${bytesToHex(viewingPublicKey).slice(2)}` as StealthMetaAddress;
}

export function decodeMetaAddress(meta: string): { spending: Uint8Array; viewing: Uint8Array } {
  const m = /^st:eth:0x([0-9a-fA-F]{132})$/.exec(meta);
  if (!m) throw new Error("invalid stealth meta-address (expects two compressed public keys)");
  const bytes = hexToBytes(`0x${m[1]}`);
  return { spending: bytes.slice(0, 33), viewing: bytes.slice(33) };
}

function hashedSecret(shared: Uint8Array): { scalar: bigint; viewTag: number } {
  const h = hexToBytes(keccak256(shared));
  const scalar = BigInt(bytesToHex(h)) % N;
  if (scalar === 0n) throw new Error("degenerate shared secret");
  return { scalar, viewTag: h[0]! };
}

function addressOf(point: InstanceType<typeof Point>): Address {
  return publicKeyToAddress(bytesToHex(point.toBytes(false)) as Hex);
}

/** Payer side: derive a one-time address for the recipient of `meta`. */
export function generateStealthAddress(meta: string, ephemeralPrivateKey = secp256k1.utils.randomSecretKey()) {
  const { spending, viewing } = decodeMetaAddress(meta);
  const shared = secp256k1.getSharedSecret(ephemeralPrivateKey, viewing, true);
  const { scalar, viewTag } = hashedSecret(shared);
  const stealthPoint = Point.fromBytes(spending).add(Point.BASE.multiply(scalar));
  return {
    stealthAddress: addressOf(stealthPoint),
    ephemeralPublicKey: bytesToHex(secp256k1.getPublicKey(ephemeralPrivateKey, true)),
    viewTag,
  };
}

/** Recipient side: cheap check whether an announcement is ours (view tag first, then the full derivation). */
export function checkStealthAddress(params: {
  stealthAddress: Address;
  ephemeralPublicKey: Hex;
  viewTag: number;
  viewingPrivateKey: Uint8Array;
  spendingPublicKey: Uint8Array;
}): boolean {
  const shared = secp256k1.getSharedSecret(params.viewingPrivateKey, hexToBytes(params.ephemeralPublicKey), true);
  const { scalar, viewTag } = hashedSecret(shared);
  if (viewTag !== params.viewTag) return false;
  const point = Point.fromBytes(params.spendingPublicKey).add(Point.BASE.multiply(scalar));
  return addressOf(point).toLowerCase() === params.stealthAddress.toLowerCase();
}

/** Recipient side: the private key that controls a stealth address. */
export function computeStealthKey(params: {
  ephemeralPublicKey: Hex;
  viewingPrivateKey: Uint8Array;
  spendingPrivateKey: Uint8Array;
}): Hex {
  const shared = secp256k1.getSharedSecret(params.viewingPrivateKey, hexToBytes(params.ephemeralPublicKey), true);
  const { scalar } = hashedSecret(shared);
  const key = (BigInt(bytesToHex(params.spendingPrivateKey)) + scalar) % N;
  return `0x${key.toString(16).padStart(64, "0")}`;
}
