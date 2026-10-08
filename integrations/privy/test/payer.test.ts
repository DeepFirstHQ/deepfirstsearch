import { afterEach, describe, expect, it } from "vitest";
import { recoverTypedDataAddress, toHex, type TypedDataDefinition } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createAgentPay, MerchantRegistry, PaymentDeniedError } from "@deepfirstsearch/agent-pay";
import { startMockServer, type MockServer } from "@deepfirstsearch/agent-pay/testing";
import { privyPayer } from "../src/index.js";

// A stand-in for Privy's API: the real createViemAccount adapter runs, and its wallet calls are answered by a local key.
const key = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
let calls = 0;
const fakePrivy = {
  wallets: () => ({
    ethereum: () => ({
      signTypedData: async (_walletId: string, body: { params: { typed_data: { domain: unknown; message: Record<string, unknown>; primary_type: string; types: Record<string, unknown> } } }) => {
        calls++;
        const t = body.params.typed_data;
        return { signature: await key.signTypedData({ domain: t.domain, message: t.message, primaryType: t.primary_type, types: t.types } as TypedDataDefinition) };
      },
      signMessage: async () => { calls++; throw new Error("not used"); },
    }),
  }),
} as never;
const payer = privyPayer({ privy: fakePrivy, walletId: "wallet-1", address: key.address });

const MERCHANT = "0x1111111111111111111111111111111111111111";
let m: MockServer | undefined;
afterEach(async () => { await m?.close(); m = undefined; calls = 0; });

describe("privyPayer", () => {
  it("signs EIP-3009 typed data that recovers to the wallet address", async () => {
    const td = {
      domain: { name: "USD Coin", version: "2", chainId: 8453, verifyingContract: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const },
      types: { TransferWithAuthorization: [{ name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" }] },
      primaryType: "TransferWithAuthorization" as const,
      message: { from: key.address, to: MERCHANT, value: 1000n, validAfter: 0n, validBefore: 1n, nonce: toHex(new Uint8Array(32)) },
    };
    const sig = await payer.signTypedData(td);
    expect(await recoverTypedDataAddress({ ...td, signature: sig })).toBe(key.address);
  });

  it("refuses to sign transactions", async () => {
    await expect(payer.signTransaction({ to: MERCHANT, value: 1n } as never)).rejects.toThrow(/only signs payment authorizations/);
  });

  it("pays an honest merchant with one Privy signature and never asks Privy for a swapped payee", async () => {
    m = await startMockServer({
      "/ok": { price: 10_000n, payTo: MERCHANT },
      "/evil": { price: 10_000n, payTo: MERCHANT, tamper: (r) => ({ ...r, payTo: "0x9999999999999999999999999999999999999999" }) },
    }, { network: "eip155:8453" });
    const pay = createAgentPay({
      registry: new MerchantRegistry([{ origin: m.url, payTo: MERCHANT, network: "eip155:8453", maxPerTx: 50_000n, pricePin: 10_000n }]),
      policy: { allowedNetworks: ["eip155:8453"] },
      payer: () => payer,
      session: { readsUntrustedInput: true, accessesSensitiveData: false, canPay: true },
    });
    const plan = pay.commitPlan([{ origin: m.url, maxSpend: 50_000n }], 60_000);
    await expect(pay.fetch(`${m.url}/evil`, {}, { plan })).rejects.toBeInstanceOf(PaymentDeniedError);
    expect(calls).toBe(0);
    expect((await pay.fetch(`${m.url}/ok`, {}, { plan })).status).toBe(200);
    expect(calls).toBe(1);
  });
});
