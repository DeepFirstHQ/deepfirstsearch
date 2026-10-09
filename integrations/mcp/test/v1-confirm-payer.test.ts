import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { burnerPayers } from "@deepfirstsearch/agent-pay";
import { startMockServer, type MockServer } from "@deepfirstsearch/agent-pay/testing";
import { Config } from "../src/config.js";
import { buildServer, payerAddresses } from "../src/server.js";

const MERCHANT = "0x1111111111111111111111111111111111111111" as const;
const secrets = { burnerSeed: new Uint8Array(32).fill(7) };
let mock: MockServer | undefined;
afterEach(async () => { await mock?.close(); mock = undefined; });

async function connect(routes: Parameters<typeof startMockServer>[0], merchant: Record<string, unknown> = {}, extra: Record<string, unknown> = {}, overrides: Record<string, unknown> = {}) {
  mock = await startMockServer(routes, { network: "eip155:84532" });
  const config = Config.parse({
    network: "eip155:84532",
    merchants: [{ origin: mock.url, payTo: MERCHANT, price: "0.01", maxPerTx: "0.02", maxSpend: "0.05", ...merchant }],
    ...extra,
  });
  const { server } = buildServer(config, secrets, { settleRetries: 0, settleRetryDelayMs: 0, ...overrides });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "test", version: "1" });
  await client.connect(b);
  const call = async (url: string) => {
    const r = (await client.callTool({ name: "paid_fetch", arguments: { url } })) as { content: { text: string }[] };
    return r.content.map((c) => c.text).join("\n");
  };
  return { call, config, url: mock.url };
}

describe("x402 v1 merchants (x402Versions)", () => {
  it("refuses a v1 402 by default and pays it when the merchant opts in", async () => {
    const routes = { "/v1": { price: 10_000n, payTo: MERCHANT, x402Version: 1 as const, body: '{"v":1}' } };
    let s = await connect(routes);
    expect(await s.call(`${s.url}/v1`)).toMatch(/refused.*version_not_allowed|v1 is off/s);
    await mock!.close(); mock = undefined;
    s = await connect(routes, { x402Versions: [1, 2] });
    expect(await s.call(`${s.url}/v1`)).toMatch(/Paid 0\.01 USDC/);
  });
});

describe("confirmOnChain (default on)", () => {
  it("is on by default and can be turned off", () => {
    const base = { network: "eip155:84532", merchants: [{ origin: "https://a.example", payTo: MERCHANT, price: "0.01", maxPerTx: "0.02", maxSpend: "0.05" }] };
    expect(Config.parse(base).confirmOnChain).toBe(true);
    expect(Config.parse({ ...base, confirmOnChain: false }).confirmOnChain).toBe(false);
  });

  it("delivers a paid response that came without a readable receipt once the chain confirms it", async () => {
    let asked = 0;
    const s = await connect(
      { "/r": { price: 10_000n, payTo: MERCHANT, rawReceipt: { settled: true }, body: '{"ok":true}' } },
      {},
      {},
      { confirmAuthorization: async () => (asked++, true) },
    );
    const text = await s.call(`${s.url}/r`);
    expect(text).toMatch(/\{"ok":true\}/);
    expect(asked).toBeGreaterThan(0);
  });
});

describe("payer addresses (#27)", () => {
  it("prints the same address the server pays from", async () => {
    const s = await connect({ "/data": { price: 10_000n, payTo: MERCHANT } });
    const payer = payerAddresses(s.config, secrets)[0]!.payer;
    const expected = burnerPayers(secrets.burnerSeed, "0x0000000000000000000000000000000000000000")({ origin: s.url, payTo: MERCHANT, network: "eip155:84532", maxPerTx: 20_000n }, 84532).address;
    expect(payer).toBe(expected);
  });
});
