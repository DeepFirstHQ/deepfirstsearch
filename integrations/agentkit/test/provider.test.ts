import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { AgentKit, ViemWalletProvider } from "@coinbase/agentkit";
import { createAgentPay, MerchantRegistry } from "@deepfirstsearch/agent-pay";
import { startMockServer, type MockServer } from "@deepfirstsearch/agent-pay/testing";
import { createWalletClient, http } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { agentKitPayer, agentPayActionProvider, PAID_FETCH_ACTION, PaidFetchSchema, type PayerAccount } from "../src/index.js";

const NETWORK = "eip155:8453";
const MERCHANT = "0x1111111111111111111111111111111111111111" as const;
const ATTACKER = "0x9999999999999999999999999999999999999999" as const;
const servers: MockServer[] = [];

// AgentKit's wallet providers report an initialization event to Coinbase (cca-lite.coinbase.com). Keep the tests
// offline and deterministic: answer that host locally, pass everything else through.
const realFetch = globalThis.fetch;
beforeAll(() => {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) =>
    String(input instanceof Request ? input.url : input).startsWith("https://cca-lite.coinbase.com")
      ? new Response("{}", { status: 200 })
      : realFetch(input, init)) as typeof fetch;
});
afterAll(() => { globalThis.fetch = realFetch; });
afterEach(async () => { await Promise.all(servers.splice(0).map((s) => s.close())); });

async function setup(opts: { maxSpend?: bigint; payer?: Parameters<typeof createAgentPay>[0]["payer"] } = {}) {
  const m = await startMockServer({
    "/data": { price: 10_000n, payTo: MERCHANT, body: '{"price":42}' },
    "/swap": { price: 10_000n, payTo: MERCHANT, tamper: (r) => ({ ...r, payTo: ATTACKER }) },
  }, { network: NETWORK });
  servers.push(m);
  const pay = createAgentPay({
    registry: new MerchantRegistry([{ origin: m.url, payTo: MERCHANT, network: NETWORK, maxPerTx: 50_000n, pricePin: 10_000n }]),
    policy: { allowedNetworks: [NETWORK] },
    payer: opts.payer ?? (() => privateKeyToAccount(generatePrivateKey()) as unknown as PayerAccount),
    session: { readsUntrustedInput: true, accessesSensitiveData: false, canPay: true },
  });
  const plan = pay.commitPlan([{ origin: m.url, maxSpend: opts.maxSpend ?? 100_000n }], 60_000);
  const provider = agentPayActionProvider({ pay, plan });
  const action = provider.getActions({} as never)[0]!;
  return { m, pay, plan, provider, action };
}

describe("AgentKit action provider", () => {
  it("pays an approved merchant and fences the response as untrusted", async () => {
    const { m, action } = await setup();
    const out = await action.invoke({ url: `${m.url}/data` });
    expect(out).toMatch(/^HTTP 200\. Paid 0\.01 USDC to 0x1111111111111111111111111111111111111111 \(tx 0x/);
    expect(out).toMatch(/<untrusted_[0-9a-f]{12}>\n\{"price":42\}\n<\/untrusted_[0-9a-f]{12}>/);
    expect(m.received).toHaveLength(1);
  });

  it("refuses a 402 that swaps the payee, with zero signatures sent", async () => {
    const { m, action } = await setup();
    const out = await action.invoke({ url: `${m.url}/swap` });
    expect(out).toMatch(/^Payment refused by policy: .*not the merchant's registered address/);
    expect(m.received).toHaveLength(0);
  });

  it("refuses an injected URL that isn't an approved merchant", async () => {
    const { action } = await setup();
    const evil = await startMockServer({ "/pay-me": { price: 5_000_000n, payTo: ATTACKER } }, { network: NETWORK });
    servers.push(evil);
    const out = await action.invoke({ url: `${evil.url}/pay-me` });
    expect(out).toMatch(/^Payment refused by policy: .*not an approved merchant/);
    expect(evil.received).toHaveLength(0);
  });

  it("stops at the sealed plan's budget", async () => {
    const { m, action } = await setup({ maxSpend: 10_000n });
    expect(await action.invoke({ url: `${m.url}/data` })).toMatch(/^HTTP 200/);
    expect(await action.invoke({ url: `${m.url}/data` })).toMatch(/^Payment refused by policy: .*sealed plan/);
    expect(m.received).toHaveLength(1);
  });

  it("gives the model no payee, amount, asset or network argument", () => {
    expect(Object.keys(PaidFetchSchema.shape).sort()).toEqual(["body", "contentType", "method", "url"]);
    expect(PaidFetchSchema.safeParse({ url: "https://x.example/a", payTo: ATTACKER }).success).toBe(false);
    expect(PaidFetchSchema.safeParse({ url: "https://x.example/a", amount: "1" }).success).toBe(false);
  });

  it("supports EVM networks only", async () => {
    const { provider } = await setup();
    expect(provider.supportsNetwork({ protocolFamily: "evm", networkId: "base-mainnet", chainId: "8453" })).toBe(true);
    expect(provider.supportsNetwork({ protocolFamily: "svm", networkId: "solana-mainnet" })).toBe(false);
  });
});

describe("with AgentKit itself", () => {
  const walletProvider = () =>
    new ViemWalletProvider(createWalletClient({ account: privateKeyToAccount(generatePrivateKey()), chain: base, transport: http("http://127.0.0.1:1") }));

  it("uses an AgentKit wallet as the payer (agentKitPayer): the merchant verifies its signature", async () => {
    const wp = walletProvider();
    const payer = agentKitPayer(wp);
    expect(payer.address).toBe(wp.getAddress());
    const { m, action } = await setup({ payer: () => payer });
    expect(await action.invoke({ url: `${m.url}/data` })).toMatch(/^HTTP 200\. Paid 0\.01 USDC/);
    expect(m.received[0]!.payload.authorization.from.toLowerCase()).toBe(wp.getAddress().toLowerCase());
  });

  it("is listed and invoked through AgentKit.getActions()", async () => {
    const wp = walletProvider();
    const { m, provider } = await setup({ payer: () => agentKitPayer(wp) });
    const agentkit = await AgentKit.from({ walletProvider: wp, actionProviders: [provider] });
    const actions = agentkit.getActions();
    const paidFetch = actions.find((a) => a.name === PAID_FETCH_ACTION);
    expect(paidFetch).toBeDefined();
    expect(await paidFetch!.invoke({ url: `${m.url}/data` })).toMatch(/^HTTP 200\. Paid 0\.01 USDC/);
    expect(await paidFetch!.invoke({ url: `${m.url}/swap` })).toMatch(/^Payment refused by policy/);
  });
});
