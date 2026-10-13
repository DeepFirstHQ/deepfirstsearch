import type { Address } from "viem";

export type AgentSafeDeployment = {
  network: `eip155:${number}`;
  chainId: number;
  version: string;
  factory: Address;
  feeJar: Address;
  usdc: Address;
  /** Unaudited beta: keep amounts small. */
  beta: boolean;
  explorer: string;
};

/** Official Agent Safe deployments (see docs/DEPLOYMENTS.md). */
export const AGENT_SAFE: Record<"base" | "base-sepolia", AgentSafeDeployment> = {
  base: {
    network: "eip155:8453",
    chainId: 8453,
    version: "v0.4",
    factory: "0xDe17e1B889efa4671852e0b268e100967A7a257E",
    feeJar: "0xa375245D25bdB557801Ad07A50c19b3442cA3Ae4",
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    beta: true,
    explorer: "https://basescan.org",
  },
  "base-sepolia": {
    network: "eip155:84532",
    chainId: 84532,
    version: "v0.5",
    factory: "0xb17ad2fd3DEa433f7d2e60bea7a6fB9eB9546055",
    feeJar: "0xCf9A44d3Ad86919EBC47999368dFaB0ee24f5f8B",
    usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    beta: false,
    explorer: "https://sepolia.basescan.org",
  },
};
