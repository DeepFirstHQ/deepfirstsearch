import { afterAll, beforeAll, describe, expect, it } from "vitest";
import axios from "axios";
import { wrapAxiosWithPayment, x402Client } from "@x402/axios";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { agentSafeGuard, axiosUrl, commitPlan, MerchantRegistry } from "../src/index.js";
import { startMockServer, type MockServer } from "../src/testing/index.js";

const MERCHANT = "0x1111111111111111111111111111111111111111";
const ATTACKER = "0x9999999999999999999999999999999999999999";
const NETWORK = "eip155:84532";
let m: MockServer;
let other: MockServer;

beforeAll(async () => {
  m = await startMockServer({
    "/ok": { price: 1_000n, payTo: MERCHANT, body: "paid" },
    "/evil": { price: 1_000n, payTo: MERCHANT, tamper: (r) => ({ ...r, payTo: ATTACKER }) },
  });
  other = await startMockServer({ "/ok": { price: 1_000n, payTo: MERCHANT } });
});
afterAll(async () => {
  await m.close();
  await other.close();
});

function setup(planSpend = 10_000n) {
  const registry = new MerchantRegistry([{ origin: m.url, payTo: MERCHANT, network: NETWORK, maxPerTx: 5_000n, pricePin: 3_000n }]);
  const plan = commitPlan(registry, [{ origin: m.url, maxSpend: planSpend }], 3_600_000);
  const guard = agentSafeGuard({ registry, plan, policy: { allowedNetworks: [NETWORK] } });
  const client = guard.install(x402Client.fromConfig({ schemes: [{ network: "eip155:*", client: new ExactEvmScheme(privateKeyToAccount(generatePrivateKey())) }] }));
  const start = m.received.length + other.received.length; // the mock servers are shared across tests
  const signatures = () => m.received.length + other.received.length - start;
  return { plan, client, signatures, make: (baseURL?: string) => guard.axios(wrapAxiosWithPayment(axios.create(baseURL ? { baseURL } : {}), client)) };
}
const refusal = (p: Promise<unknown>) => p.then((r) => `HTTP ${(r as { status: number }).status}`, (e: Error) => e.message);

describe("guard.axios with @x402/axios", () => {
  it("pays the pinned payee through every call style: instance(), request, get and post", async () => {
    const t = setup();
    const api = t.make(m.url);
    expect((await api.get("/ok")).data).toBe("paid");
    expect((await api.request({ url: "/ok" })).status).toBe(200);
    expect((await api({ url: "/ok" })).status).toBe(200);
    expect((await api.post("/ok", { q: 1 })).status).toBe(200);
    expect(t.plan.remaining(m.url)).toBe(6_000n);
    expect(t.signatures()).toBe(4);
  });

  it("refuses a swapped payee with payee_mismatch and nothing signed", async () => {
    const t = setup();
    const r = await refusal(t.make(m.url).get("/evil"));
    expect(r).toMatch(/payee_mismatch/);
    expect(t.signatures()).toBe(0);
  });

  it("judges the origin actually requested: an absolute URL overrides baseURL", async () => {
    const t = setup();
    const r = await refusal(t.make(m.url).get(`${other.url}/ok`)); // right payee and price, but not the registered origin
    expect(r).toMatch(/unknown_merchant/);
    expect(t.signatures()).toBe(0);
  });

  it("refuses an instance used without the guard (the origin is unknown)", async () => {
    const t = setup();
    const bare = wrapAxiosWithPayment(axios.create({ baseURL: m.url }), t.client);
    expect(await refusal(bare.get("/ok"))).toMatch(/unknown_merchant/);
    expect(t.signatures()).toBe(0);
  });

  it("stops at the sealed plan", async () => {
    const t = setup(1_000n);
    const api = t.make(m.url);
    expect((await api.get("/ok")).status).toBe(200);
    expect(await refusal(api.get("/ok"))).toMatch(/plan_exhausted/);
    expect(t.signatures()).toBe(1);
  });

  it("resolves URLs the way axios does", () => {
    expect(axiosUrl("/ok", "https://api.example.com/v1/")).toBe("https://api.example.com/v1/ok");
    expect(axiosUrl("ok", "https://api.example.com/v1")).toBe("https://api.example.com/v1/ok");
    expect(axiosUrl("https://other.example/x", "https://api.example.com")).toBe("https://other.example/x");
    expect(axiosUrl("//cdn.example/x", "https://api.example.com")).toBe("//cdn.example/x");
    expect(axiosUrl(undefined, "https://api.example.com")).toBe("https://api.example.com");
    expect(axiosUrl("/ok", undefined)).toBe("/ok");
  });
});
