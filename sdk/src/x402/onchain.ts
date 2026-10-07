import type { Address, Hex, PublicClient } from "viem";

/**
 * Asks the token whether a signed EIP-3009 authorization was already used on-chain. The client calls it only when a
 * merchant's receipt is missing or unreadable after the retries (issue #16), never on the normal path.
 */
export type AuthorizationCheck = (q: { network: string; asset: Address; authorizer: Address; nonce: Hex }) => Promise<boolean>;

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
 * A network without a client answers "not used", so the payment stays unconfirmed (fails closed).
 */
export function usdcAuthorizationCheck(clients: Record<string, PublicClient>): AuthorizationCheck {
  return async ({ network, asset, authorizer, nonce }) => {
    const client = clients[network];
    if (!client) return false;
    return client.readContract({ address: asset, abi: AUTHORIZATION_STATE_ABI, functionName: "authorizationState", args: [authorizer, nonce] });
  };
}
