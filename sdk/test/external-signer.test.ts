import { afterEach, describe, expect, it } from "vitest";
import { toAccount, privateKeyToAccount } from "viem/accounts";
import { createAgentPay } from "../src/x402/client.js";
import { MerchantRegistry } from "../src/policy/registry.js";
import { startMockServer, type MockServer } from "../examples/mock-x402-server.js";

// Partners (embedded/agent wallet providers) keep their own signer: the SDK only needs a viem account whose
// signTypedData is backed by their API, KMS or enclave. Here a "remote" signer is simulated with an async boundary.
const MERCHANT = "0x1111111111111111111111111111111111111111";
const ATTACKER = "0x9999999999999999999999999999999999999999";
const enclaveKey = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
let remoteCalls = 0;
const remoteSigner = toAccount({
  address: enclaveKey.address,
  async signMessage({ message }) { remoteCalls++; return enclaveKey.signMessage({ message }); },
  async signTransaction(tx) { remoteCalls++; return enclaveKey.signTransaction(tx); },
  async signTypedData(td) { remoteCalls++; await new Promise((r) => setTimeout(r, 5)); return enclaveKey.signTypedData(td as never); },
});

let mock: MockServer | undefined;
afterEach(async () => { await mock?.close(); mock = undefined; remoteCalls = 0; });

describe("partner wallets: any viem account can be the payer", () => {
  it("pays through a remote signer and still refuses a payee swap without asking it to sign", async () => {
    mock = await startMockServer({
      "/data": { price: 10_000n, payTo: MERCHANT },
      "/swap": { price: 10_000n, payTo: MERCHANT, tamper: (r) => ({ ...r, payTo: ATTACKER }) },
    });
    const pay = createAgentPay({
      registry: new MerchantRegistry([{ origin: mock.url, payTo: MERCHANT, network: "eip155:84532", maxPerTx: 50_000n, pricePin: 10_000n }]),
      policy: { allowedNetworks: ["eip155:84532"] },
      payer: () => remoteSigner,
      session: { readsUntrustedInput: true, accessesSensitiveData: false, canPay: true },
      settleRetries: 0,
    });
    const plan = pay.commitPlan([{ origin: mock.url, maxSpend: 100_000n }], 60_000);
    expect((await pay.fetch(`${mock.url}/data`, {}, { plan })).status).toBe(200);
    expect(remoteCalls).toBe(1);
    expect(mock.received[0]!.payload.authorization.from.toLowerCase()).toBe(enclaveKey.address.toLowerCase());
    await expect(pay.fetch(`${mock.url}/swap`, {}, { plan })).rejects.toThrow(/payTo/);
    expect(remoteCalls).toBe(1); // the partner's signer was never even asked
  });
});
