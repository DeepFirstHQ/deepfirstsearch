import { getAddress, type Address, type PublicClient } from "viem";

/**
 * Sanctions screening. Returns true when an address must NOT be paid.
 * Run against every payee before signing, regardless of what the owner configured.
 */
export type SanctionsScreen = (address: Address) => Promise<boolean>;

/** Screen against a list you maintain, e.g. addresses parsed from OFAC's SDN list (sdn_advanced.xml). */
export function staticListScreen(addresses: Iterable<string>): SanctionsScreen {
  const set = new Set([...addresses].map((a) => getAddress(a)));
  return async (address) => set.has(getAddress(address));
}

const ORACLE_ABI = [
  {
    type: "function",
    name: "isSanctioned",
    stateMutability: "view",
    inputs: [{ name: "addr", type: "address" }],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

/**
 * Screen with an on-chain sanctions oracle exposing `isSanctioned(address)` (Chainalysis publishes one).
 * Oracles can lag the official list, so combine with `staticListScreen`. If the oracle cannot be reached,
 * the payment is blocked (fail closed).
 */
export function oracleScreen(client: PublicClient, oracle: Address): SanctionsScreen {
  return async (address) => {
    try {
      return await client.readContract({ address: oracle, abi: ORACLE_ABI, functionName: "isSanctioned", args: [address] });
    } catch {
      return true;
    }
  };
}

/** Blocks if any screen blocks. */
export function anyScreen(...screens: SanctionsScreen[]): SanctionsScreen {
  return async (address) => {
    for (const screen of screens) if (await screen(address)) return true;
    return false;
  };
}
