import type { Address } from "viem";

/**
 * Pinned payment assets. The EIP-712 domain used to sign is always taken from here, never from the server's
 * `extra` field: a malicious server could otherwise make the agent sign for a different token or chain.
 * Note the domain name differs between Base ("USD Coin") and Base Sepolia ("USDC").
 */
export type PinnedAsset = {
  network: `eip155:${number}`;
  chainId: number;
  asset: Address;
  domain: { name: string; version: string };
  decimals: number;
};

export const PINNED_USDC: Record<string, PinnedAsset> = {
  "eip155:8453": {
    network: "eip155:8453",
    chainId: 8453,
    asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    domain: { name: "USD Coin", version: "2" },
    decimals: 6,
  },
  "eip155:84532": {
    network: "eip155:84532",
    chainId: 84532,
    asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    domain: { name: "USDC", version: "2" },
    decimals: 6,
  },
};

export function pinnedAsset(network: string, overrides: Record<string, PinnedAsset> = {}): PinnedAsset | undefined {
  return overrides[network] ?? PINNED_USDC[network];
}
