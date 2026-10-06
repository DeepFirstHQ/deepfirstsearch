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
  /**
   * Top up ahead of time (default true): when the payer can cover this payment but not the next one, a top-up is
   * sent in the background, so the funds have time to reach the facilitator's node before they are needed. It is
   * best effort: if the vault refuses it (for example, the daily cap), the current payment still uses the existing
   * balance, and the next call tries again.
   */
  prefund?: boolean;
};

/**
 * Returns an `ensureFunded` hook for `createAgentPay`: before a payment, if the merchant's burner holds less than
 * the amount, the agent tops it up from the BudgetVault. The vault enforces every limit on-chain; this function
 * cannot exceed them even if it is called with bad input.
 */
export function vaultFunder(opts: VaultFunderOptions) {
  if (opts.tranche <= 0n) throw new Error("tranche must be positive");
  const pending = new Map<Address, Promise<void>>();
  // One funding decision per payer at a time: parallel payments must not each read the same balance and top up twice.
  const locks = new Map<Address, Promise<unknown>>();

  const fund = async (id: Hex, payer: Address, topUp: bigint) => {
    if (topUp <= 0n) return;
    const hash = await opts.agent.writeContract({
      address: opts.vault,
      abi: BUDGET_VAULT_ABI,
      functionName: "fundBurner",
      args: [id, payer, topUp],
      account: opts.agent.account!,
      chain: opts.agent.chain,
      ...(opts.dataSuffix ? { dataSuffix: opts.dataSuffix } : {}),
    });
    const receipt = await opts.publicClient.waitForTransactionReceipt({ hash, confirmations: opts.confirmations ?? 2 });
    if (receipt.status !== "success") throw new Error(`fundBurner reverted (${hash})`);
  };

  const ensure = async (payer: LocalAccount, merchant: Merchant, amount: bigint): Promise<void> => {
    if (amount <= 0n) throw new Error("amount must be positive");
    const id = opts.intents[merchant.payTo];
    if (!id) throw new Error(`no owner-signed intent for ${merchant.payTo}`);

    // Let a background top-up from the previous call land first (its failure is not this payment's failure).
    const inFlight = pending.get(payer.address);
    if (inFlight) {
      pending.delete(payer.address);
      await inFlight.catch(() => undefined);
    }

    const balance = await opts.publicClient.readContract({
      address: opts.usdc,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [payer.address],
    });
    if (balance >= amount) {
      if ((opts.prefund ?? true) && balance - amount < amount && opts.tranche > balance) {
        const p = fund(id, payer.address, opts.tranche - balance);
        p.catch(() => undefined);
        pending.set(payer.address, p);
      }
      return;
    }

    // Fill up to a full tranche, or to the payment itself if it is larger. The vault's caps still bound this on-chain.
    const target = opts.tranche > amount ? opts.tranche : amount;
    await fund(id, payer.address, target - balance);
  };

  return (payer: LocalAccount, merchant: Merchant, amount: bigint): Promise<void> => {
    const previous = locks.get(payer.address) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(() => ensure(payer, merchant, amount));
    locks.set(payer.address, run);
    void run.finally(() => {
      if (locks.get(payer.address) === run) locks.delete(payer.address);
    }).catch(() => undefined);
    return run;
  };
}
