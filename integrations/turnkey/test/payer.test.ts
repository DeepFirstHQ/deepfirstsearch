import { readFileSync, existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { recoverTypedDataAddress, type Hex } from "viem";
import { privateKeyToAccount, sign } from "viem/accounts";
import { createAgentPay, MerchantRegistry } from "@deepfirstsearch/agent-pay";
import { startMockServer } from "@deepfirstsearch/agent-pay/testing";
import { turnkeyPayer, type TurnkeySigner } from "../src/index.js";

const MERCHANT = "0x1111111111111111111111111111111111111111";
const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex;

// Behaves like Turnkey's signRawPayload with HASH_FUNCTION_NO_OP, returning v as Turnkey does ("00"/"01") or legacy (27/28).
function fakeTurnkey(vStyle: "parity" | "legacy") {
  let calls = 0;
  const client: TurnkeySigner = {
    async signRawPayload({ payload }) {
      calls++;
      const s = await sign({ hash: payload as Hex, privateKey: KEY });
      const yp = s.yParity ?? 0; const v = vStyle === "parity" ? yp : yp + 27;
      return { r: s.r.slice(2), s: s.s.slice(2), v: v.toString(16).padStart(2, "0") };
    },
  };
  return { client, calls: () => calls };
}

async function run(account: ReturnType<typeof turnkeyPayer>) {
  const m = await startMockServer({
    "/data": { price: 10_000n, payTo: MERCHANT },
    "/swap": { price: 10_000n, payTo: MERCHANT, tamper: (r) => ({ ...r, payTo: "0x9999999999999999999999999999999999999999" }) },
  });
  const pay = createAgentPay({
    registry: new MerchantRegistry([{ origin: m.url, payTo: MERCHANT, network: "eip155:84532", maxPerTx: 50_000n, pricePin: 10_000n }]),
    policy: { allowedNetworks: ["eip155:84532"] },
    payer: () => account,
    session: { readsUntrustedInput: true, accessesSensitiveData: false, canPay: true },
    settleRetries: 0,
  });
  const plan = pay.commitPlan([{ origin: m.url, maxSpend: 50_000n }], 60_000);
  const ok = await pay.fetch(`${m.url}/data`, {}, { plan });
  const swap = await pay.fetch(`${m.url}/swap`, {}, { plan }).then(() => "paid", (e: Error) => e.message);
  await m.close();
  return { status: ok.status, payer: m.received[0]?.payload.authorization.from, swap };
}

describe("turnkeyPayer", () => {
  for (const style of ["parity", "legacy"] as const) {
    it(`signs x402 authorizations that verify (v as ${style}) and is never asked to sign an attack`, async () => {
      const t = fakeTurnkey(style);
      const address = privateKeyToAccount(KEY).address;
      const r = await run(turnkeyPayer({ client: t.client, address }));
      expect(r.status).toBe(200);
      expect(r.payer?.toLowerCase()).toBe(address.toLowerCase());
      expect(r.swap).toMatch(/payTo/);
      expect(t.calls()).toBe(1);
    });
  }

  it("refuses to sign transactions", async () => {
    const t = fakeTurnkey("parity");
    await expect(turnkeyPayer({ client: t.client, address: privateKeyToAccount(KEY).address }).signTransaction({} as never)).rejects.toThrow(/only signs payment/);
  });

  // Runs against a real Turnkey organization when credentials are present (never in CI).
  const CREDS = process.env.TURNKEY_CREDS;
  it.skipIf(!CREDS || !existsSync(CREDS))("live: a key held in Turnkey pays through the SDK", async () => {
    const { Turnkey } = await import("@turnkey/sdk-server");
    const c = JSON.parse(readFileSync(CREDS!, "utf8"));
    const tk = new Turnkey({ apiBaseUrl: "https://api.turnkey.com", apiPublicKey: c.apiPublicKey, apiPrivateKey: c.apiPrivateKey, defaultOrganizationId: c.organizationId });
    const account = turnkeyPayer({ client: tk.apiClient() as unknown as TurnkeySigner, address: c.address });
    const td = transfer(c.address, USDC_BASE_SEPOLIA);
    expect(await recoverTypedDataAddress({ ...(td as object), signature: await account.signTypedData(td) } as never)).toBe(c.address);
    const r = await run(account);
    expect(r.status).toBe(200);
    expect(r.swap).toMatch(/payTo/);
  }, 60_000);
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

describe("turnkeyPayer signs only USDC TransferWithAuthorization from its own key", () => {
  const address = privateKeyToAccount(KEY).address;

  it("signs a transfer on Base and on Base Sepolia", async () => {
    const t = fakeTurnkey("parity");
    const payer = turnkeyPayer({ client: t.client, address });
    for (const domain of [USDC_BASE, USDC_BASE_SEPOLIA]) {
      const td = transfer(address, domain);
      expect(await recoverTypedDataAddress({ ...(td as object), signature: await payer.signTypedData(td) } as never)).toBe(address);
    }
    expect(t.calls()).toBe(2);
  });

  it("refuses messages without calling Turnkey", async () => {
    const t = fakeTurnkey("parity");
    await expect(turnkeyPayer({ client: t.client, address }).signMessage({ message: "Sign in to evil.example" })).rejects.toThrow(/only signs payment/);
    expect(t.calls()).toBe(0);
  });

  for (const [name, td] of notPayments(address)) {
    it(`refuses ${name} without calling Turnkey`, async () => {
      const t = fakeTurnkey("parity");
      await expect(turnkeyPayer({ client: t.client, address }).signTypedData(td)).rejects.toThrow(/refusing to sign/);
      expect(t.calls()).toBe(0);
    });
  }
});
