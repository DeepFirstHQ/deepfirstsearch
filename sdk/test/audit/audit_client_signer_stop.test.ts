import { describe, expect, it, vi } from "vitest";
import type { Hex, LocalAccount } from "viem";
import { PaymentBlockedError } from "../../src/guard/controls.js";
import { PINNED_USDC } from "../../src/policy/networks.js";
import { MerchantRegistry } from "../../src/policy/registry.js";
import { createAgentPay, type AgentPayOptions } from "../../src/x402/client.js";
import { encodeHeader } from "../../src/x402/codec.js";

const ORIGIN = "https://signer-stop.invalid";
const NETWORK = "eip155:84532";
const PAYEE = "0x1111111111111111111111111111111111111111";
const PAYER = "0x2222222222222222222222222222222222222222";
const ASSET = PINNED_USDC[NETWORK]!;
const PRICE = 1_000n;
// An intentionally invalid one-byte placeholder: never a usable payment signature.
const TEST_SIGNATURE: Hex = "0x00";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

/** The production SDK client with in-memory transport and signer doubles. No
 * private key is created, no real signature is generated, and no network is used.
 */
function setup(opts: {
  sign?: () => Promise<Hex>;
  ensureFunded?: AgentPayOptions["ensureFunded"];
} = {}) {
  const signing = vi.fn(opts.sign ?? (async () => TEST_SIGNATURE));
  const account = { address: PAYER, signTypedData: signing } as unknown as LocalAccount;
  const outgoingProofs: string[] = [];
  const transport = vi.fn(async (_input: unknown, init?: RequestInit): Promise<Response> => {
    const proof = new Headers(init?.headers).get("PAYMENT-SIGNATURE");
    if (proof) {
      outgoingProofs.push(proof);
      return new Response("fixture response", { status: 200, headers: {
        "PAYMENT-RESPONSE": encodeHeader({ success: true, transaction: "", network: NETWORK, payer: PAYER }),
      } });
    }
    return new Response(null, { status: 402, headers: {
      "PAYMENT-REQUIRED": encodeHeader({ x402Version: 2, accepts: [{
        scheme: "exact", network: NETWORK, asset: ASSET.asset, payTo: PAYEE,
        amount: PRICE.toString(), maxTimeoutSeconds: 60,
        extra: { name: ASSET.domain.name, version: ASSET.domain.version, assetTransferMethod: "eip3009" },
      }] }),
    } });
  });
  const pay = createAgentPay({
    registry: new MerchantRegistry([{ origin: ORIGIN, payTo: PAYEE, network: NETWORK, maxPerTx: PRICE }]),
    policy: { allowedNetworks: [NETWORK] },
    payer: () => account,
    session: { readsUntrustedInput: true, accessesSensitiveData: false, canPay: true },
    ensureFunded: opts.ensureFunded,
    fetch: transport as typeof fetch,
    now: () => 1_800_000_000_000,
    settleRetries: 0,
  });
  const plan = pay.commitPlan([{ origin: ORIGIN, maxSpend: 5_000n }], 60_000);
  return {
    pay, plan, signing, transport, outgoingProofs,
    request: () => pay.fetch(`${ORIGIN}/resource`, {}, { plan }),
  };
}

describe("main SDK client stop control around the asynchronous signer", () => {
  it("continues through the simulated signer when the stop control is clear", async () => {
    const t = setup();
    await expect(t.request()).resolves.toMatchObject({ status: 200 });
    expect(t.signing).toHaveBeenCalledOnce();
    expect(t.outgoingProofs).toHaveLength(1);
  });

  it("stops before transport or signing when already killed", async () => {
    const t = setup();
    t.pay.kill("fixture stop before request");
    await expect(t.request()).rejects.toBeInstanceOf(PaymentBlockedError);
    expect(t.transport).not.toHaveBeenCalled();
    expect(t.signing).not.toHaveBeenCalled();
    expect(t.outgoingProofs).toHaveLength(0);
  });

  it("stops before signing when killed while the funding hook completes", async () => {
    let stop!: () => void;
    const t = setup({ ensureFunded: async () => { stop(); } });
    stop = () => t.pay.kill("fixture stop during funding hook");
    await expect(t.request()).rejects.toBeInstanceOf(PaymentBlockedError);
    expect(t.signing).not.toHaveBeenCalled();
    expect(t.outgoingProofs).toHaveLength(0);
  });

  it("does not send the simulated signer result when killed during the signer wait", async () => {
    const entered = deferred<void>();
    const answer = deferred<Hex>();
    const t = setup({ sign: () => {
      entered.resolve(undefined);
      return answer.promise;
    } });
    const outcome = t.request().then(
      () => ({ kind: "sent" as const }),
      (error: unknown) => ({ kind: "blocked" as const, error }),
    );
    await entered.promise;
    expect(t.signing).toHaveBeenCalledOnce();
    expect(t.outgoingProofs).toHaveLength(0);
    t.pay.kill("fixture stop while awaiting signer");
    answer.resolve(TEST_SIGNATURE);

    expect.soft(await outcome).toMatchObject({
      kind: "blocked",
      error: expect.objectContaining({ code: "kill_switch" }),
    });
    expect.soft(t.outgoingProofs).toHaveLength(0);
  });
});
