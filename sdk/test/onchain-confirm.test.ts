import { afterEach, describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { createAgentPay, PaymentBlockedError, MerchantRegistry, usdcAuthorizationCheck, type AuthorizationCheck } from "../src/index.js";
import { startMockServer, type MockServer } from "../src/testing/index.js";
import { PINNED_USDC } from "../src/policy/networks.js";

// Issue #16: a merchant's receipt doesn't name the transaction (Robtex sends {settled: true, method: "direct"}).
// With confirmAuthorization, the SDK asks the token whether the signed authorization was used.
const MERCHANT = "0x1111111111111111111111111111111111111111" as const;
const NETWORK = "eip155:84532";
const payer = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
let server: MockServer | undefined;
afterEach(async () => { await server?.close(); server = undefined; });

async function setup(route: Parameters<typeof startMockServer>[0][string], check?: AuthorizationCheck, fetchImpl?: typeof fetch) {
  server = await startMockServer({ "/r": route });
  const pay = createAgentPay({
    registry: new MerchantRegistry([{ origin: server.url, payTo: MERCHANT, network: NETWORK, maxPerTx: 50_000n, pricePin: 10_000n }]),
    policy: { allowedNetworks: [NETWORK] },
    payer: () => payer,
    session: { readsUntrustedInput: true, accessesSensitiveData: false, canPay: true },
    settleRetries: 1, settleRetryDelayMs: 0,
    ...(check ? { confirmAuthorization: check } : {}),
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  });
  const plan = pay.commitPlan([{ origin: server.url, maxSpend: 50_000n }], 60_000);
  return { pay, plan, url: `${server.url}/r` };
}
const robtex = { price: 10_000n, payTo: MERCHANT, rawReceipt: { settled: true, method: "direct" }, body: '{"dns":"ok"}' };

describe("on-chain confirmation when the receipt is unusable (#16)", () => {
  it("counts the payment as settled when the authorization was used on-chain", async () => {
    const calls: Parameters<AuthorizationCheck>[0][] = [];
    const { pay, plan, url } = await setup(robtex, async (q) => (calls.push(q), true));
    const res = await pay.fetch(url, {}, { plan });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{"dns":"ok"}');
    expect(res.payment?.confirmedOnChain).toBe(true);
    expect(res.payment?.amount).toBe(10_000n);
    expect(calls).toHaveLength(1);
    const signed = server!.received[0]!.payload.authorization;
    expect(calls[0]).toEqual({ network: NETWORK, asset: PINNED_USDC[NETWORK]!.asset, authorizer: signed.from, nonce: signed.nonce });
    expect(new Set(server!.received.map((r) => r.payload.signature)).size).toBe(1); // never re-signed
  });

  it("stays unconfirmed when the authorization was not used (Robtex today: no money moved)", async () => {
    const { pay, plan, url } = await setup(robtex, async () => false);
    await expect(pay.fetch(url, {}, { plan })).rejects.toThrow(/settlement not confirmed/);
  });

  it("stays unconfirmed when the check itself fails (fails closed)", async () => {
    const { pay, plan, url } = await setup(robtex, async () => { throw new Error("rpc down"); });
    await expect(pay.fetch(url, {}, { plan })).rejects.toBeInstanceOf(PaymentBlockedError);
  });

  it("keeps asking the chain while the settlement transaction is not mined yet", async () => {
    let calls = 0;
    const { pay, plan, url } = await setup(robtex, async () => ++calls === 3);
    const res = await pay.fetch(url, {}, { plan });
    expect(res.payment?.confirmedOnChain).toBe(true);
    expect(calls).toBe(3);
  });

  it("asks the chain instead of resending when the resource came without a readable receipt", async () => {
    // CoinMarketCap: HTTP 200 with the data and a non-standard receipt; a resend of the spent authorization gets a 402.
    const { pay, plan, url } = await setup({ ...robtex, rawReceipt: { success: true, txHash: "0xab", networkId: NETWORK } }, async () => true);
    const res = await pay.fetch(url, {}, { plan });
    expect(await res.text()).toBe('{"dns":"ok"}');
    expect(res.payment?.confirmedOnChain).toBe(true);
    expect(server!.received).toHaveLength(1); // sent once, not resent
  });

  it("does not call the chain when the receipt is valid", async () => {
    let called = 0;
    const { pay, plan, url } = await setup({ price: 10_000n, payTo: MERCHANT }, async () => (called++, true));
    expect((await pay.fetch(url, {}, { plan })).status).toBe(200);
    expect(called).toBe(0);
  });

  it("reports a settled-but-undelivered payment plainly and never resends it", async () => {
    const real = globalThis.fetch;
    const broken: typeof fetch = async (input, init) => {
      const r = await real(input, init);
      return new Headers(init?.headers).get("PAYMENT-SIGNATURE") ? new Response("oops", { status: 500 }) : r;
    };
    const { pay, plan, url } = await setup({ price: 10_000n, payTo: MERCHANT }, async () => true, broken);
    await expect(pay.fetch(url, {}, { plan })).rejects.toThrow(/used on-chain .* HTTP 500/);
  });
});

describe("usdcAuthorizationCheck", () => {
  it("reads authorizationState on the network's client, and answers 'not used' without one", async () => {
    const reads: unknown[] = [];
    const client = { readContract: async (a: unknown) => (reads.push(a), true) } as never;
    const check = usdcAuthorizationCheck({ "eip155:8453": client });
    const q = { network: "eip155:8453", asset: PINNED_USDC["eip155:8453"]!.asset, authorizer: payer.address, nonce: `0x${"ab".repeat(32)}` as const };
    expect(await check(q)).toBe(true);
    expect(reads[0]).toMatchObject({ address: q.asset, functionName: "authorizationState", args: [q.authorizer, q.nonce] });
    expect(await check({ ...q, network: "eip155:1" })).toBe(false);
  });
});

// Read-only, against Base mainnet: an authorization our package wallet used to pay CoinGecko on 2026-10-07
// (tx 0x624f3c76…76b0, event AuthorizationUsed) must read as used; a fresh nonce must not.
describe.skipIf(!process.env.BASE_RPC_URL)("usdcAuthorizationCheck on Base mainnet (BASE_RPC_URL)", () => {
  it("sees a real used authorization and a fresh nonce as unused", async () => {
    const { createPublicClient, http } = await import("viem");
    const { base } = await import("viem/chains");
    const check = usdcAuthorizationCheck({ "eip155:8453": createPublicClient({ chain: base, transport: http(process.env.BASE_RPC_URL) }) as never });
    const q = { network: "eip155:8453", asset: PINNED_USDC["eip155:8453"]!.asset, authorizer: "0x950678F64Cf10A803C5c0355a618029AFf0D1a58" as const };
    expect(await check({ ...q, nonce: "0xce48eef7e30f9e330016a7f9371d8175c1aa94abcd37144e2364f2efadd4ce53" })).toBe(true);
    expect(await check({ ...q, nonce: `0x${"00".repeat(31)}01` })).toBe(false);
  }, 30_000);
});
