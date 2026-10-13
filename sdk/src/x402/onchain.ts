import type { Address, Hex, PublicClient } from "viem";

/**
 * Asks the token whether a signed EIP-3009 authorization was already used on-chain. The client calls it only when a
 * merchant's receipt is missing or unreadable after the retries (issue #16), never on the normal path.
 *
 * `true`: used. `false`: unused, and (when `validBefore` is given) proven unable to execute any more: answer `false`
 * then only from a block whose timestamp is past `validBefore`. `undefined`: can't tell (no client, RPC behind).
 * Neither `undefined` nor an error ever leads to a new signature.
 */
export type AuthorizationCheck = (q: {
  network: string;
  asset: Address;
  authorizer: Address;
  nonce: Hex;
  /** The authorization's validBefore (unix seconds), when the caller needs to know it can no longer execute. */
  validBefore?: bigint;
}) => Promise<boolean | undefined>;

const AUTHORIZATION_STATE_ABI = [
  {
    type: "function",
    name: "authorizationState",
    stateMutability: "view",
    inputs: [{ name: "authorizer", type: "address" }, { name: "nonce", type: "bytes32" }],
    outputs: [{ type: "bool" }],
  },
] as const;

/**
 * An AuthorizationCheck backed by USDC's `authorizationState(authorizer, nonce)` (EIP-3009), with one public client
 * per CAIP-2 network, e.g. `{ "eip155:8453": createPublicClient({ chain: base, transport: http() }) }`.
 * A network without a client answers "unknown", never "unused". When `validBefore` is asked about, "unused" is
 * answered only from the latest block if its timestamp is past `validBefore` (a lagging RPC answers "unknown"), and
 * that needs `getBlock` on the client.
 */
/** The client methods used; a Pick so a chain-specific client (e.g. Base, with OP-stack formatters) fits. */
export type ReadClient = Pick<PublicClient, "readContract"> & Partial<Pick<PublicClient, "getBlock">>;

export function usdcAuthorizationCheck(clients: Record<string, ReadClient>): AuthorizationCheck {
  return async ({ network, asset, authorizer, nonce, validBefore }) => {
    const client = clients[network];
    if (!client) return undefined;
    const read = (blockNumber?: bigint) =>
      client.readContract({ address: asset, abi: AUTHORIZATION_STATE_ABI, functionName: "authorizationState", args: [authorizer, nonce], ...(blockNumber !== undefined ? { blockNumber } : {}) });
    if (validBefore === undefined) return read();
    if (!client.getBlock) return (await read()) ? true : undefined;
    const block = await client.getBlock({ blockTag: "latest" });
    if (await read(block.number)) return true;
    return block.timestamp > validBefore ? false : undefined;
  };
}
