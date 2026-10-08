import type { Address, LocalAccount } from "viem";
import { toAccount } from "viem/accounts";
import type { CdpClient } from "@coinbase/cdp-sdk";

/** Which CDP Server Wallet v2 EVM account pays: look it up by address or by name. */
export type CdpPayerParams =
  | { cdp: CdpClient; address: Address; name?: never }
  | { cdp: CdpClient; name: string; address?: never };

const refuse = (what: string) => async (): Promise<never> => {
  throw new Error(`cdpPayer only signs payment authorizations (EIP-712 typed data), not ${what}`);
};

/**
 * A Coinbase CDP Server Wallet v2 account as an Agent Safe payer:
 * `const payer = await cdpPayer({ cdp, name: "my-agent" })`, then `payer: () => payer`.
 * The key stays in CDP's TEE and every payment is checked against the owner's rules (allowlisted payee, pinned price,
 * sealed plan, budget) before CDP is asked to sign.
 *
 * It looks the account up with `cdp.evm.getAccount` (it never creates one) and wraps CDP's own `signTypedData` with
 * viem's `toAccount`. x402's EIP-3009 authorizations are EIP-712 typed data, so that is the only thing it signs:
 * transactions, messages and raw hashes are refused, so a compromised agent can't use the account for anything else.
 */
export async function cdpPayer(params: CdpPayerParams): Promise<LocalAccount> {
  const account = await params.cdp.evm.getAccount(
    params.address !== undefined ? { address: params.address } : { name: params.name },
  );
  return toAccount({
    address: account.address,
    signTypedData: (typedData) => account.signTypedData(typedData as Parameters<typeof account.signTypedData>[0]),
    signMessage: refuse("messages"),
    signTransaction: refuse("transactions"),
  });
}
