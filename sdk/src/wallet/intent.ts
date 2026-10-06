import type { Address, Hex, LocalAccount } from "viem";

/** EIP-712 types of a BudgetVault intent. Must match `BudgetVault.INTENT_TYPEHASH`. */
export const INTENT_TYPES = {
  Intent: [
    { name: "agent", type: "address" },
    { name: "counterparty", type: "address" },
    { name: "burner", type: "address" },
    { name: "token", type: "address" },
    { name: "maxPerTx", type: "uint128" },
    { name: "maxPerPeriod", type: "uint128" },
    { name: "trancheCap", type: "uint128" },
    { name: "period", type: "uint32" },
    { name: "validAfter", type: "uint64" },
    { name: "expiry", type: "uint64" },
    { name: "nonce", type: "uint256" },
  ],
} as const;

/**
 * A budget the owner signs for one agent key and one merchant. `burner` is the only payer address the vault may
 * fund for this intent (use `burnerAddress()`), or the zero address to allow direct `pay` only.
 */
export interface Intent {
  agent: Address;
  counterparty: Address;
  burner: Address;
  token: Address;
  maxPerTx: bigint;
  maxPerPeriod: bigint;
  trancheCap: bigint;
  period: number;
  validAfter: bigint;
  expiry: bigint;
  nonce: bigint;
}

export function intentDomain(vault: Address, chainId: number) {
  return { name: "Deep First Search Agent Safe", version: "1", chainId, verifyingContract: vault } as const;
}

/** Signs an intent with the owner's account. Never run this inside the agent process. */
export function signIntent(owner: LocalAccount, vault: Address, chainId: number, intent: Intent): Promise<Hex> {
  return owner.signTypedData({ domain: intentDomain(vault, chainId), types: INTENT_TYPES, primaryType: "Intent", message: intent });
}
