import { bytesToHex, type Address, type Hex, type LocalAccount } from "viem";
import type { PinnedAsset } from "../policy/networks.js";
import type { Authorization } from "./schemas.js";

export const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

export function usdcDomain(asset: PinnedAsset) {
  return {
    name: asset.domain.name,
    version: asset.domain.version,
    chainId: asset.chainId,
    verifyingContract: asset.asset,
  } as const;
}

/**
 * Signs an EIP-3009 `transferWithAuthorization` for the x402 "exact" scheme. The domain comes from the pinned asset
 * (never from the server), the nonce is 32 random bytes, and the validity window is as short as the server allows.
 */
export async function signExactAuthorization(params: {
  account: LocalAccount;
  asset: PinnedAsset;
  to: Address;
  value: bigint;
  validForSeconds: number;
  nowSeconds: number;
}): Promise<{ authorization: Authorization; signature: Hex }> {
  const { account, asset, to, value } = params;
  // A small backdate tolerates clock skew between us and the facilitator.
  const validAfter = BigInt(params.nowSeconds - 30);
  const validBefore = BigInt(params.nowSeconds + params.validForSeconds);
  const nonce = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));

  const message = { from: account.address, to, value, validAfter, validBefore, nonce };
  const signature = await account.signTypedData({
    domain: usdcDomain(asset),
    types: TRANSFER_WITH_AUTHORIZATION_TYPES,
    primaryType: "TransferWithAuthorization",
    message,
  });

  return {
    signature,
    authorization: {
      from: account.address,
      to,
      value: value.toString(),
      validAfter: validAfter.toString(),
      validBefore: validBefore.toString(),
      nonce,
    },
  };
}
