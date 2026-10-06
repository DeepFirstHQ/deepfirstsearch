import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { bytesToHex, getAddress, type Address, type LocalAccount } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Merchant } from "../policy/registry.js";

const N = secp256k1.Point.Fn.ORDER;
const enc = new TextEncoder();

/**
 * Derives the burner payer key for one merchant. Each merchant sees a different payer address, so no two merchants
 * can match the same agent's purchases by address. Keys are deterministic (recoverable from the owner seed), and the
 * `epoch` lets the owner rotate every burner at once.
 *
 * Limitation, stated plainly: burners are funded from the vault on-chain, so an analyst who follows the funding
 * transactions can still link them. Full unlinkability needs the shielded pool planned for a later phase.
 */
export function deriveBurnerKey(params: {
  ownerSeed: Uint8Array;
  vault: Address;
  chainId: number;
  counterparty: Address;
  epoch?: number;
}): `0x${string}` {
  if (params.ownerSeed.length < 32) throw new Error("owner seed must be at least 32 bytes");
  const salt = enc.encode(getAddress(params.vault));
  for (let counter = 0; counter < 16; counter++) {
    const info = enc.encode(
      `dfs/burner/v1|${params.chainId}|${getAddress(params.counterparty)}|${params.epoch ?? 0}|${counter}`,
    );
    const okm = hkdf(sha256, params.ownerSeed, salt, info, 32);
    const k = BigInt(bytesToHex(okm));
    // Reject 0 and values >= n instead of reducing, so the key is uniformly distributed.
    if (k > 0n && k < N) return bytesToHex(okm);
  }
  throw new Error("could not derive a valid key");
}

/**
 * The burner address for one merchant, for the owner to put in the intent it signs (`Intent.burner`). The vault only
 * funds that exact address, so a stolen agent key cannot redirect tranches to addresses of its own choosing.
 */
export function burnerAddress(params: {
  ownerSeed: Uint8Array;
  vault: Address;
  chainId: number;
  counterparty: Address;
  epoch?: number;
}): Address {
  return privateKeyToAccount(deriveBurnerKey(params)).address;
}

/** Returns a payer provider that gives every merchant its own burner account. */
export function burnerPayers(ownerSeed: Uint8Array, vault: Address, epoch = 0) {
  const cache = new Map<string, LocalAccount>();
  return (merchant: Merchant, chainId: number): LocalAccount => {
    const key = `${chainId}:${merchant.payTo}`;
    let account = cache.get(key);
    if (!account) {
      account = privateKeyToAccount(deriveBurnerKey({ ownerSeed, vault, chainId, counterparty: merchant.payTo, epoch }));
      cache.set(key, account);
    }
    return account;
  };
}
