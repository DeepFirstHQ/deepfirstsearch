import { describe, expect, it, vi } from "vitest";
import { createAgentPay } from "../../../sdk/src/x402/client.js";
import { encodeHeader } from "../../../sdk/src/x402/codec.js";
import { PINNED_USDC } from "../../../sdk/src/policy/networks.js";
import { MerchantRegistry } from "../../../sdk/src/policy/registry.js";
import { oracleScreen, type SanctionsScreen } from "../../../sdk/src/policy/sanctions.js";
import { paidFetchTool, type PaidFetchResult, type PaidFetchToolOptions } from "../src/index.js";

const ORIGIN = "https://screen-errors.invalid";
const NETWORK = "eip155:84532";
const PAYEE = "0x1111111111111111111111111111111111111111";
const ORACLE = "0x3333333333333333333333333333333333333333";
const ASSET = PINNED_USDC[NETWORK]!;
// Synthetic diagnostic text only: no real service URL or credential is involved.
const MARKER = "FAKE_TEST_RPC_TOKEN";
const INTERNAL_URL = `https://rpc.invalid/v2/${MARKER}`;
const INTERNAL_ERROR = `RPC request failed at ${INTERNAL_URL}`;

/** Real tool, local SDK client, registry, plan and screening path. Transport and
 * oracle calls are simulated, and the payer must never be reached in these cases.
 */
function setup(opts: { screen?: SanctionsScreen; transportError?: boolean } = {}) {
  const payer = vi.fn(() => { throw new Error("Test must stop before payer creation"); });
  const transport = vi.fn(async (_input: unknown, _init?: RequestInit): Promise<Response> => {
    if (opts.transportError) throw new Error(INTERNAL_ERROR);
    return new Response(null, { status: 402, headers: {
      "PAYMENT-REQUIRED": encodeHeader({ x402Version: 2, accepts: [{
        scheme: "exact", network: NETWORK, asset: ASSET.asset, payTo: PAYEE,
        amount: "1000", maxTimeoutSeconds: 60,
        extra: { name: ASSET.domain.name, version: ASSET.domain.version, assetTransferMethod: "eip3009" },
      }] }),
    } });
  });
  const pay = createAgentPay({
    registry: new MerchantRegistry([{ origin: ORIGIN, payTo: PAYEE, network: NETWORK, maxPerTx: 1_000n }]),
    policy: { allowedNetworks: [NETWORK] },
    payer,
    session: { readsUntrustedInput: true, accessesSensitiveData: false, canPay: true },
    ...(opts.screen ? { screen: opts.screen } : {}),
    fetch: transport as typeof fetch,
    now: () => 1_800_000_000_000,
    settleRetries: 0,
  });
  const plan = pay.commitPlan([{ origin: ORIGIN, maxSpend: 5_000n }], 60_000);
  const tool = paidFetchTool({
    pay: pay as unknown as PaidFetchToolOptions["pay"],
    plan: plan as unknown as PaidFetchToolOptions["plan"],
  });
  return {
    payer, transport,
    async run(): Promise<PaidFetchResult> {
      const result = await tool.execute!(
        { url: `${ORIGIN}/resource`, method: "GET" },
        { toolCallId: "local-screen-error", messages: [], context: {} },
      ) as PaidFetchResult;
      expect(payer).not.toHaveBeenCalled();
      expect(transport).toHaveBeenCalledOnce();
      return result;
    },
  };
}

function refusalReason(result: PaidFetchResult): string {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("Expected a refusal or a sanitized failure");
  return result.reason;
}

describe("screening diagnostics do not enter model-visible tool results", () => {
  it("redacts ordinary transport errors", async () => {
    const result = await setup({ transportError: true }).run();
    expect(result).toMatchObject({ ok: false, refused: false });
    expect(refusalReason(result)).not.toContain(MARKER);
    expect(refusalReason(result)).not.toContain(INTERNAL_URL);
  });

  it("blocks a flagged payee with a stable refusal code", async () => {
    const result = await setup({ screen: async () => true }).run();
    expect(result).toMatchObject({ ok: false, refused: true, code: "sanctioned_payee" });
    expect(refusalReason(result)).not.toContain(MARKER);
  });

  it("keeps RPC diagnostics private when the built-in oracle screen fails", async () => {
    const readContract = vi.fn(async () => { throw new Error(INTERNAL_ERROR); });
    const screen = oracleScreen({ readContract }, ORACLE);
    const result = await setup({ screen }).run();
    expect(readContract).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ ok: false, refused: true, code: "sanctioned_payee" });
    expect(refusalReason(result)).not.toContain(MARKER);
    expect(refusalReason(result)).not.toContain(INTERNAL_URL);
  });

  it("also redacts diagnostics when an owner-provided screen throws", async () => {
    const result = await setup({ screen: async () => { throw new Error(INTERNAL_ERROR); } }).run();
    expect(result).toMatchObject({ ok: false, refused: true, code: "sanctioned_payee" });
    expect.soft(refusalReason(result)).not.toContain(MARKER);
    expect.soft(refusalReason(result)).not.toContain(INTERNAL_URL);
  });
});
