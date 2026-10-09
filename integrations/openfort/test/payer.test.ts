import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createPublicKey, generateKeyPairSync, type KeyObject } from "node:crypto";
import { jwtVerify } from "jose";
import { recoverTypedDataAddress, toHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import Openfort from "@openfort/openfort-node";
import { createAgentPay, MerchantRegistry, PaymentDeniedError } from "@deepfirstsearch/agent-pay";
import { startMockServer, type MockServer } from "@deepfirstsearch/agent-pay/testing";
import { openfortPayer } from "../src/index.js";

// A stand-in for Openfort's backend-wallet API on localhost: the real Openfort client (API key, wallet-auth JWT, its own
// signTypedData, which hashes locally and asks the API to sign the hash) runs unchanged against it, with a local key.
const key = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const ID = "acc_agent_pay_test";
const SECRET = "sk_test_local_stand_in";
let signCalls = 0;
let otherWrites = 0;
let api: Server;
let openfort: Openfort;
let walletPublicKey: KeyObject;

const readBody = async (req: import("node:http").IncomingMessage) => {
  let s = "";
  for await (const chunk of req) s += chunk;
  return s ? JSON.parse(s) : undefined;
};

beforeAll(async () => {
  const wallet = generateKeyPairSync("ec", { namedCurve: "P-256" });
  walletPublicKey = createPublicKey(wallet.privateKey);
  api = createServer(async (req, res) => {
    const json = (status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (req.headers.authorization !== `Bearer ${SECRET}`) return json(401, { error: { message: "bad api key" } });
    const url = new URL(req.url ?? "", "http://x");
    const accountJson = { id: ID, object: "account", address: key.address, wallet: "pla_test", custody: "Developer", chainType: "EVM", createdAt: 1 };
    if (req.method === "GET" && url.pathname === `/v2/accounts/${ID}`) return json(200, accountJson);
    if (req.method === "GET" && url.pathname.startsWith("/v2/accounts/")) return json(404, { error: { message: "account not found" } });
    if (req.method === "GET" && url.pathname === "/v2/accounts") {
      const match = url.searchParams.get("address")?.toLowerCase() === key.address.toLowerCase();
      return json(200, { object: "list", data: match ? [accountJson] : [], start: 0, end: match ? 1 : 0, total: match ? 1 : 0 });
    }
    if (req.method === "POST" && url.pathname === `/v2/accounts/backend/${ID}/sign`) {
      // Openfort requires a wallet-auth JWT (ES256, signed with the wallet secret) on backend-wallet writes.
      const token = req.headers["x-wallet-auth"];
      if (typeof token !== "string") return json(401, { error: { message: "no wallet auth" } });
      try {
        await jwtVerify(token, walletPublicKey, { algorithms: ["ES256"] });
      } catch {
        return json(401, { error: { message: "bad wallet auth" } });
      }
      signCalls++;
      const { data } = await readBody(req);
      return json(200, { object: "signature", account: ID, signature: await key.sign({ hash: data as Hex }) });
    }
    otherWrites++;
    return json(400, { error: { message: `unexpected ${req.method} ${url.pathname}` } });
  });
  await new Promise<void>((r) => api.listen(0, "127.0.0.1", r));
  openfort = new Openfort(SECRET, {
    basePath: `http://127.0.0.1:${(api.address() as AddressInfo).port}`,
    walletSecret: wallet.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
  });
});
afterAll(async () => { await new Promise((r) => api.close(r)); });

const MERCHANT = "0x1111111111111111111111111111111111111111";
let m: MockServer | undefined;
afterEach(async () => { await m?.close(); m = undefined; signCalls = 0; otherWrites = 0; });

describe("openfortPayer", () => {
  it("looks the backend wallet up by id or by address", async () => {
    expect((await openfortPayer({ openfort, id: ID })).address).toBe(key.address);
    expect((await openfortPayer({ openfort, address: key.address })).address).toBe(key.address);
    await expect(openfortPayer({ openfort, id: "acc_missing" })).rejects.toThrow();
    await expect(openfortPayer({ openfort, address: "0x2222222222222222222222222222222222222222" })).rejects.toThrow();
    expect(otherWrites).toBe(0);
  });

  it("signs EIP-3009 typed data that recovers to the wallet address", async () => {
    const payer = await openfortPayer({ openfort, id: ID });
    const td = {
      domain: { name: "USD Coin", version: "2", chainId: 8453, verifyingContract: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const },
      types: { TransferWithAuthorization: [{ name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" }] },
      primaryType: "TransferWithAuthorization" as const,
      message: { from: key.address, to: MERCHANT, value: 1000n, validAfter: 0n, validBefore: 1n, nonce: toHex(new Uint8Array(32)) },
    };
    const sig = await payer.signTypedData(td);
    expect(await recoverTypedDataAddress({ ...td, signature: sig })).toBe(key.address);
    expect(signCalls).toBe(1);
  });

  it("refuses to sign transactions or messages, without calling Openfort", async () => {
    const payer = await openfortPayer({ openfort, id: ID });
    await expect(payer.signTransaction({ to: MERCHANT, value: 1n } as never)).rejects.toThrow(/only signs payment authorizations/);
    await expect(payer.signMessage({ message: "hi" })).rejects.toThrow(/only signs payment authorizations/);
    expect(payer.sign).toBeUndefined();
    expect(signCalls + otherWrites).toBe(0);
  });

  it("pays an honest merchant with one Openfort signature and never asks Openfort for a swapped payee", async () => {
    m = await startMockServer({
      "/ok": { price: 10_000n, payTo: MERCHANT },
      "/evil": { price: 10_000n, payTo: MERCHANT, tamper: (r) => ({ ...r, payTo: "0x9999999999999999999999999999999999999999" }) },
    }, { network: "eip155:8453" });
    const payer = await openfortPayer({ openfort, id: ID });
    const pay = createAgentPay({
      registry: new MerchantRegistry([{ origin: m.url, payTo: MERCHANT, network: "eip155:8453", maxPerTx: 50_000n, pricePin: 10_000n }]),
      policy: { allowedNetworks: ["eip155:8453"] },
      payer: () => payer,
      session: { readsUntrustedInput: true, accessesSensitiveData: false, canPay: true },
    });
    const plan = pay.commitPlan([{ origin: m.url, maxSpend: 50_000n }], 60_000);
    await expect(pay.fetch(`${m.url}/evil`, {}, { plan })).rejects.toBeInstanceOf(PaymentDeniedError);
    expect(signCalls).toBe(0);
    expect((await pay.fetch(`${m.url}/ok`, {}, { plan })).status).toBe(200);
    expect(signCalls).toBe(1);
    expect(otherWrites).toBe(0);
  });
});
