import type { Address, LocalAccount } from "viem";
import { toAccount } from "viem/accounts";
import type { PrivyClient } from "@privy-io/node";
import { createViemAccount, type CreateViemAccountInput } from "@privy-io/node/viem";
import { assertPaymentAuthorization } from "./guard.js";

const refuse = (what: string) => async (): Promise<never> => {
  throw new Error(`privyPayer only signs payment authorizations (EIP-712 typed data), not ${what}`);
};

/**
 * A Privy server wallet as an Agent Safe payer (`payer: () => privyPayer(...)`): the key stays in Privy and every
 * payment is checked against the owner's rules (allowlisted payee, pinned price, sealed plan, budget) before Privy is
 * asked to sign.
 *
 * It uses Privy's own viem adapter (`createViemAccount`), whose `signTypedData` (EIP-712, what x402's EIP-3009
 * authorizations are) we verified recovers to the wallet address on Base mainnet, and exposes only that, through
 * viem's `toAccount`: the adapter's raw-hash `sign`, EIP-7702 `signAuthorization`, `signMessage` and `signTransaction`
 * are not reachable, and typed data other than a USDC `TransferWithAuthorization` from this wallet is refused
 * (`assertPaymentAuthorization`), so a compromised agent can't use the wallet for anything but x402 payments.
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
  return toAccount({
    address: account.address,
    signTypedData: async (typedData) => {
      assertPaymentAuthorization(typedData, account.address);
      return account.signTypedData(typedData);
    },
    signMessage: refuse("messages"),
    signTransaction: refuse("transactions"),
  });
}
