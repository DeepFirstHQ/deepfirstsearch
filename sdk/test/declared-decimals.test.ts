import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { agentSafeGuard, commitPlan, createAgentPay, dryRun, MerchantRegistry, PaymentDeniedError } from "../src/index.js";
import { startMockServer, type MockServer } from "../src/testing/index.js";

/**
 * Some x402 clients price a 402 with the decimals the server declares (`extra.decimals`), so 1,000 USDC declared with
 * 18 decimals looks like $0.000000001. Agent Safe compares atomic amounts of the pinned asset against the owner's pins,
 * so the declaration changes nothing: these tests keep it that way.
 */
const MERCHANT = "0x1111111111111111111111111111111111111111";
const NETWORK = "eip155:84532";
let m: MockServer;

beforeAll(async () => {
  m = await startMockServer({
    "/big": { price: 1_000_000_000n, payTo: MERCHANT, tamper: (r) => ({ ...r, extra: { ...(r.extra ?? {}), decimals: 18 } }) },
  });
});
afterAll(async () => { await m.close(); });

const registry = () => new MerchantRegistry([{ origin: m.url, payTo: MERCHANT, network: NETWORK, maxPerTx: 50_000n, pricePin: 10_000n }]);

describe("a 402 that declares its own decimals", () => {
  it("dryRun refuses 1,000 USDC declared with 18 decimals (over the cap, above the pin)", async () => {
    const reg = registry();
    const v = await dryRun(await fetch(`${m.url}/big`), { url: `${m.url}/big`, policy: { allowedNetworks: [NETWORK] }, registry: reg, plan: commitPlan(reg, [{ origin: m.url, maxSpend: 100_000n }], 60_000) });
    expect(v.kind).toBe("deny");
    expect(v.kind === "deny" && v.codes[0]).toBe("over_cap");
  });

  it("createAgentPay refuses it with nothing signed", async () => {
    const before = m.received.length;
    const pay = createAgentPay({
      registry: registry(), policy: { allowedNetworks: [NETWORK] }, payer: () => privateKeyToAccount(generatePrivateKey()),
      session: { readsUntrustedInput: true, accessesSensitiveData: false, canPay: true },
    });
    const err = await pay.fetch(`${m.url}/big`, {}, { plan: pay.commitPlan([{ origin: m.url, maxSpend: 100_000n }], 60_000) }).catch((e) => e);
    expect(err).toBeInstanceOf(PaymentDeniedError);
    expect(err.code).toBe("over_cap");
    expect(m.received.length).toBe(before);
  });

  it("agentSafeGuard refuses it even with the official client's own cap turned off (setSpendControls(false))", async () => {
    const before = m.received.length;
    const reg = registry();
    const guard = agentSafeGuard({ registry: reg, plan: commitPlan(reg, [{ origin: m.url, maxSpend: 100_000n }], 60_000), policy: { allowedNetworks: [NETWORK] } });
    const client = x402Client.fromConfig({ schemes: [{ network: "eip155:*", client: new ExactEvmScheme(privateKeyToAccount(generatePrivateKey())) }] });
    // With its default $1 cap, the official client already refuses this; some apps turn that cap off.
    const bare = await wrapFetchWithPayment(fetch, client)(`${m.url}/big`).then(() => "PAID", (e: Error) => e.message);
    expect(bare).not.toBe("PAID");
    client.setSpendControls(false);
    const err = await guard.fetch(wrapFetchWithPayment(fetch, guard.install(client)))(`${m.url}/big`).then(() => "PAID", (e: Error) => e.message);
    expect(err).toMatch(/over_cap/);
    expect(m.received.length).toBe(before);
  });
});
