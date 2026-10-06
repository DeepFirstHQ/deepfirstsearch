import { erc20Abi, type Address, type Hex, type LocalAccount, type PublicClient, type WalletClient } from "viem";
import type { Merchant } from "../policy/registry.js";

/** The subset of BudgetVault the agent uses. The agent key can only spend; it can never authorize. */
export const BUDGET_VAULT_ABI = [
  {
    type: "function",
    name: "fundBurner",
    stateMutability: "nonpayable",
    inputs: [
      { name: "id", type: "bytes32" },
      { name: "burner", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "pay",
    stateMutability: "nonpayable",
    inputs: [
      { name: "id", type: "bytes32" },
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

export type VaultFunderOptions = {
  /** Wallet client holding the agent's session key (the intent's `agent`). */
  agent: WalletClient;
  publicClient: PublicClient;
  vault: Address;
  usdc: Address;
  /** Owner-signed intent id for each merchant payee. A merchant without an intent cannot be funded. */
  intents: Record<Address, Hex>;
  /** Top up to this many atomic units at a time (must be <= the intent's trancheCap). */
  tranche: bigint;
  /** Optional ERC-8021 attribution suffix (your Base Builder Code), appended to the agent's transactions. */
  dataSuffix?: Hex;
  /**
   * Blocks to wait after funding before the payment is signed (default 2). The facilitator settles through its own
   * RPC node, which can lag behind ours; paying on the first confirmation made settlement fail intermittently.
   */
  confirmations?: number;
};

/**
 * Returns an `ensureFunded` hook for `createAgentPay`: before a payment, if the merchant's burner holds less than
 * the amount, the agent tops it up from the BudgetVault. The vault enforces every limit on-chain; this function
 * cannot exceed them even if it is called with bad input.
 */
export function vaultFunder(opts: VaultFunderOptions) {
  return async (payer: LocalAccount, merchant: Merchant, amount: bigint): Promise<void> => {
    const id = opts.intents[merchant.payTo];
    if (!id) throw new Error(`no owner-signed intent for ${merchant.payTo}`);

    const balance = await opts.publicClient.readContract({
      address: opts.usdc,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [payer.address],
    });
    if (balance >= amount) return;

    const topUp = opts.tranche > amount - balance ? opts.tranche - balance : amount - balance;
    const hash = await opts.agent.writeContract({
      address: opts.vault,
      abi: BUDGET_VAULT_ABI,
      functionName: "fundBurner",
      args: [id, payer.address, topUp],
      account: opts.agent.account!,
      chain: opts.agent.chain,
      ...(opts.dataSuffix ? { dataSuffix: opts.dataSuffix } : {}),
    });
    const receipt = await opts.publicClient.waitForTransactionReceipt({ hash, confirmations: opts.confirmations ?? 2 });
    if (receipt.status !== "success") throw new Error(`fundBurner reverted (${hash})`);
  };
}
