import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { generateKeyPairSync } from "node:crypto";
import { recoverTypedDataAddress, toHex, type TypedDataDefinition } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { CdpClient } from "@coinbase/cdp-sdk";
import { createAgentPay, MerchantRegistry, PaymentDeniedError } from "@deepfirstsearch/agent-pay";
import { startMockServer, type MockServer } from "@deepfirstsearch/agent-pay/testing";
import { cdpPayer } from "../src/index.js";

process.env.DISABLE_CDP_USAGE_TRACKING = "true";
process.env.DISABLE_CDP_ERROR_REPORTING = "true";

// A stand-in for CDP's Wallet API on localhost: the real CdpClient (JWT auth, wallet auth, its own signTypedData) runs
// unchanged against it, and the account's key is a local one.
const key = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const NAME = "agent-pay-test";
let signCalls = 0;
let otherWrites = 0;
let api: Server;
let cdp: CdpClient;

const readBody = async (req: import("node:http").IncomingMessage) => {
  let s = "";
  for await (const chunk of req) s += chunk;
  return s ? JSON.parse(s) : undefined;
};
// CDP's API takes uint256 values as decimal strings (the SDK converts bigints before sending).
const toBigInts = (types: Record<string, { name: string; type: string }[]>, primaryType: string, message: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(message).map(([k, v]) => {
    const t = types[primaryType]?.find((f) => f.name === k)?.type ?? "";
    return [k, /^u?int\d*$/.test(t) ? BigInt(v as string) : v];
  }));

beforeAll(async () => {
  api = createServer(async (req, res) => {
    const json = (status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (!req.headers.authorization?.startsWith("Bearer ")) return json(401, { errorType: "unauthorized", errorMessage: "no JWT" });
    const path = req.url ?? "";
    const accountJson = { address: key.address, name: NAME, policies: [], createdAt: "2026-10-08T00:00:00Z", updatedAt: "2026-10-08T00:00:00Z" };
    if (req.method === "GET" && (path === `/platform/v2/evm/accounts/by-name/${NAME}` || path === `/platform/v2/evm/accounts/${key.address}`)) return json(200, accountJson);
    if (req.method === "GET" && path.startsWith("/platform/v2/evm/accounts/")) return json(404, { errorType: "not_found", errorMessage: "account not found" });
    if (req.method === "POST" && path === `/platform/v2/evm/accounts/${key.address}/sign/typed-data`) {
      if (!req.headers["x-wallet-auth"]) return json(401, { errorType: "unauthorized", errorMessage: "no wallet auth" });
      signCalls++;
      const t = await readBody(req);
      const { EIP712Domain: _domainTypes, ...types } = t.types;
      const message = toBigInts(types, t.primaryType, t.message);
      return json(200, { signature: await key.signTypedData({ domain: t.domain, types, primaryType: t.primaryType, message } as TypedDataDefinition) });
    }
    otherWrites++;
    return json(400, { errorType: "invalid_request", errorMessage: `unexpected ${req.method} ${path}` });
  });
  await new Promise<void>((r) => api.listen(0, "127.0.0.1", r));
  const ec = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const wallet = generateKeyPairSync("ec", { namedCurve: "P-256" });
  cdp = new CdpClient({
    apiKeyId: "test-key-id",
    apiKeySecret: ec.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    walletSecret: wallet.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
    basePath: `http://127.0.0.1:${(api.address() as AddressInfo).port}/platform`,
  });
});
afterAll(async () => { await new Promise((r) => api.close(r)); });

const MERCHANT = "0x1111111111111111111111111111111111111111";
let m: MockServer | undefined;
afterEach(async () => { await m?.close(); m = undefined; signCalls = 0; otherWrites = 0; });

describe("cdpPayer", () => {
  it("looks the account up by name or address", async () => {
    expect((await cdpPayer({ cdp, name: NAME })).address).toBe(key.address);
    expect((await cdpPayer({ cdp, address: key.address })).address).toBe(key.address);
    await expect(cdpPayer({ cdp, name: "missing" })).rejects.toThrow();
  });

  it("signs EIP-3009 typed data that recovers to the account address", async () => {
    const payer = await cdpPayer({ cdp, name: NAME });
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

  it("refuses to sign transactions or messages, without calling CDP", async () => {
    const payer = await cdpPayer({ cdp, name: NAME });
    await expect(payer.signTransaction({ to: MERCHANT, value: 1n } as never)).rejects.toThrow(/only signs payment authorizations/);
    await expect(payer.signMessage({ message: "hi" })).rejects.toThrow(/only signs payment authorizations/);
    expect(payer.sign).toBeUndefined();
    expect(signCalls + otherWrites).toBe(0);
  });

  it("pays an honest merchant with one CDP signature and never asks CDP for a swapped payee", async () => {
    m = await startMockServer({
      "/ok": { price: 10_000n, payTo: MERCHANT },
      "/evil": { price: 10_000n, payTo: MERCHANT, tamper: (r) => ({ ...r, payTo: "0x9999999999999999999999999999999999999999" }) },
    }, { network: "eip155:8453" });
    const payer = await cdpPayer({ cdp, name: NAME });
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
