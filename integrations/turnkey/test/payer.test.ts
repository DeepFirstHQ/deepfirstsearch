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
    const td = { domain: { name: "USDC", version: "2", chainId: 84532, verifyingContract: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const }, types: { M: [{ name: "x", type: "uint256" }] }, primaryType: "M" as const, message: { x: 1n } };
    expect(await recoverTypedDataAddress({ ...td, signature: await account.signTypedData(td) })).toBe(c.address);
    const r = await run(account);
    expect(r.status).toBe(200);
    expect(r.swap).toMatch(/payTo/);
  }, 60_000);
});
