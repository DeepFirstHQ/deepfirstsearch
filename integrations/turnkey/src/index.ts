import { hashMessage, hashTypedData, serializeSignature, type Address, type Hex, type LocalAccount } from "viem";
import { toAccount } from "viem/accounts";

/** The subset of Turnkey's API client this needs (`new Turnkey({...}).apiClient()` from @turnkey/sdk-server). */
export type TurnkeySigner = {
  signRawPayload(input: {
    signWith: string;
    payload: string;
    encoding: "PAYLOAD_ENCODING_HEXADECIMAL";
    hashFunction: "HASH_FUNCTION_NO_OP";
  }): Promise<{ r: string; s: string; v: string }>;
};

/**
 * A viem account whose key never leaves Turnkey, for use as an Agent Safe payer (`payer: () => turnkeyPayer(...)`).
 *
 * Typed data (EIP-712, which x402's EIP-3009 authorizations use) is hashed locally with viem and Turnkey signs that
 * exact digest. In our tests `@turnkey/viem` 0.14.44's `signTypedData` recovered to a different address, while
 * signing the digest recovers correctly; doing it this way also makes what Turnkey signs fully auditable.
 * Transactions are not supported: an x402 payer only signs authorizations.
 */
export function turnkeyPayer(params: { client: TurnkeySigner; address: Address }): LocalAccount {
  const { client, address } = params;
  const signDigest = async (digest: Hex): Promise<Hex> => {
    const r = await client.signRawPayload({ signWith: address, payload: digest, encoding: "PAYLOAD_ENCODING_HEXADECIMAL", hashFunction: "HASH_FUNCTION_NO_OP" });
    return serializeSignature({ r: `0x${r.r.padStart(64, "0")}`, s: `0x${r.s.padStart(64, "0")}`, yParity: ((v) => (v >= 27 ? v - 27 : v))(Number.parseInt(r.v, 16)) });
  };
  return toAccount({
    address,
    signMessage: ({ message }) => signDigest(hashMessage(message)),
    signTypedData: (td) => signDigest(hashTypedData(td as Parameters<typeof hashTypedData>[0])),
    signTransaction: async () => {
      throw new Error("turnkeyPayer only signs payment authorizations, not transactions");
    },
  });
}
