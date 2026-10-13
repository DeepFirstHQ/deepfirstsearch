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

// Typed data for the guard tests: the pinned USDC domains, an EIP-3009 transfer and a USDC Permit.
const USDC_BASE = { name: "USD Coin", version: "2", chainId: 8453, verifyingContract: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" } as const;
const USDC_BASE_SEPOLIA = { name: "USDC", version: "2", chainId: 84532, verifyingContract: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" } as const;
const TRANSFER_TYPES = { TransferWithAuthorization: [{ name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" }] };
const transfer = (from: string, domain: Record<string, unknown> = USDC_BASE, types: Record<string, unknown> = TRANSFER_TYPES) =>
  ({ domain, types, primaryType: "TransferWithAuthorization", message: { from, to: "0x1111111111111111111111111111111111111111", value: 1000n, validAfter: 0n, validBefore: 1n, nonce: `0x${"00".repeat(32)}` } }) as never;
const permit = (owner: string) =>
  ({
    domain: USDC_BASE,
    types: { Permit: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }, { name: "value", type: "uint256" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }] },
    primaryType: "Permit",
    message: { owner, spender: "0x9999999999999999999999999999999999999999", value: 2n ** 256n - 1n, nonce: 0n, deadline: 2n ** 255n },
  }) as never;
const notPayments = (from: string): [string, never][] => [
  ["a USDC Permit with unlimited allowance", permit(from)],
  ["a transfer on another verifyingContract", transfer(from, { ...USDC_BASE, verifyingContract: "0x9999999999999999999999999999999999999999" })],
  ["a transfer on another chainId", transfer(from, { ...USDC_BASE, chainId: 1 })],
  ["a transfer with Base Sepolia's domain name on Base", transfer(from, { ...USDC_BASE, name: "USDC" })],
  ["a transfer from another address", transfer("0x2222222222222222222222222222222222222222")],
  ["a transfer whose EIP712Domain leaves out verifyingContract", transfer(from, USDC_BASE, { ...TRANSFER_TYPES, EIP712Domain: [{ name: "name", type: "string" }, { name: "version", type: "string" }, { name: "chainId", type: "uint256" }] })],
];

describe("privyPayer signs only USDC TransferWithAuthorization from its own wallet", () => {
  it("exposes no raw-hash sign, no EIP-7702 signAuthorization, and refuses messages and transactions", async () => {
    const p = payer as unknown as Record<string, unknown>;
    expect(p.sign).toBeUndefined();
    expect(p.signAuthorization).toBeUndefined();
    await expect(payer.signMessage({ message: "Sign in to evil.example" })).rejects.toThrow(/only signs payment authorizations/);
    await expect(payer.signTransaction({ to: MERCHANT, value: 1n } as never)).rejects.toThrow(/only signs payment authorizations/);
    expect(calls).toBe(0);
  });

  it("signs a transfer on Base and on Base Sepolia", async () => {
    for (const domain of [USDC_BASE, USDC_BASE_SEPOLIA]) {
      const td = transfer(key.address, domain);
      expect(await recoverTypedDataAddress({ ...(td as object), signature: await payer.signTypedData(td) } as never)).toBe(key.address);
    }
    expect(calls).toBe(2);
  });

  for (const [name, td] of notPayments(key.address)) {
    it(`refuses ${name} without asking Privy`, async () => {
      await expect(payer.signTypedData(td)).rejects.toThrow(/refusing to sign/);
      expect(calls).toBe(0);
    });
  }
});
