import type { Address, LocalAccount } from "viem";
import { toAccount } from "viem/accounts";
import type Openfort from "@openfort/openfort-node";

/** Which Openfort backend wallet pays: look it up by its id (`acc_…`) or by address. */
export type OpenfortPayerParams =
  | { openfort: Openfort; id: string; address?: never }
  | { openfort: Openfort; address: Address; id?: never };

const refuse = (what: string) => async (): Promise<never> => {
  throw new Error(`openfortPayer only signs payment authorizations (EIP-712 typed data), not ${what}`);
};

/**
 * An Openfort backend wallet as an Agent Safe payer:
 * `const payer = await openfortPayer({ openfort, id: "acc_…" })`, then `payer: () => payer`.
 * The key stays with Openfort and every payment is checked against the owner's rules (allowlisted payee, pinned price,
 * sealed plan, budget) before Openfort is asked to sign.
 *
 * It looks the wallet up with `openfort.accounts.evm.backend.get` (it never creates one) and wraps the wallet's own
 * `signTypedData` with viem's `toAccount`. x402's EIP-3009 authorizations are EIP-712 typed data, so that is the only
 * thing it signs: transactions, messages and raw hashes are refused, so a compromised agent can't use the wallet for
 * anything else through this signer.
 */
export async function openfortPayer(params: OpenfortPayerParams): Promise<LocalAccount> {
  const account = await params.openfort.accounts.evm.backend.get(
    params.id !== undefined ? { id: params.id } : { address: params.address },
  );
  return toAccount({
    address: account.address,
    signTypedData: (typedData) => account.signTypedData(typedData as Parameters<typeof account.signTypedData>[0]),
    signMessage: refuse("messages"),
    signTransaction: refuse("transactions"),
  });
}
