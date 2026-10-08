import type { Address, LocalAccount } from "viem";
import type { PrivyClient } from "@privy-io/node";
import { createViemAccount, type CreateViemAccountInput } from "@privy-io/node/viem";

/**
 * A Privy server wallet as an Agent Safe payer (`payer: () => privyPayer(...)`): the key stays in Privy and every
 * payment is checked against the owner's rules (allowlisted payee, pinned price, sealed plan, budget) before Privy is
 * asked to sign.
 *
 * It uses Privy's own viem adapter (`createViemAccount`), whose `signTypedData` (EIP-712, what x402's EIP-3009
 * authorizations are) we verified recovers to the wallet address on Base mainnet. Transactions are refused: an x402
 * payer only signs payment authorizations, so a compromised agent can't use it to send arbitrary transactions.
 */
export function privyPayer(params: {
  privy: PrivyClient;
  walletId: string;
  address: Address;
  /** Optional Privy authorization context, if the wallet has an owner or policies that require one. */
  authorizationContext?: CreateViemAccountInput["authorizationContext"];
}): LocalAccount {
  const account = createViemAccount(params.privy, {
    walletId: params.walletId,
    address: params.address,
    ...(params.authorizationContext ? { authorizationContext: params.authorizationContext } : {}),
  });
  return {
    ...account,
    signTransaction: async () => {
      throw new Error("privyPayer only signs payment authorizations, not transactions");
    },
  } as LocalAccount;
}
