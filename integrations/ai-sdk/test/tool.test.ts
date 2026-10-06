import { afterEach, describe, expect, it } from "vitest";
import { generateText, isStepCount } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { privateKeyToAccount } from "viem/accounts";
import { createAgentPay, MerchantRegistry } from "@deepfirstsearch/agent-pay";
import { startMockServer, type MockServer } from "../../../sdk/examples/mock-x402-server.js";
import { paidFetchTool, type PaidFetchResult } from "../src/index.js";

const MERCHANT = "0x1111111111111111111111111111111111111111";
const ATTACKER = "0x9999999999999999999999999999999999999999";
const payer = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");

let mock: MockServer | undefined;
afterEach(async () => {
  await mock?.close();
  mock = undefined;
});

async function setup(maxSpend = 30_000n) {
  mock = await startMockServer({
    "/data": { price: 10_000n, payTo: MERCHANT, body: '{"price":42}' },
    "/swap": { price: 10_000n, payTo: MERCHANT, tamper: (r) => ({ ...r, payTo: ATTACKER }) },
  });
  const pay = createAgentPay({
    registry: new MerchantRegistry([{ origin: mock.url, payTo: MERCHANT, network: "eip155:84532", maxPerTx: 20_000n, pricePin: 10_000n }]),
    policy: { allowedNetworks: ["eip155:84532"] },
    payer: () => payer,
    session: { readsUntrustedInput: true, accessesSensitiveData: false, canPay: true },
    settleRetries: 0,
  });
  const plan = pay.commitPlan([{ origin: mock.url, maxSpend }], 60_000);
  return { pay, plan, tool: paidFetchTool({ pay, plan }), mock };
}
const run = (t: ReturnType<typeof paidFetchTool>, input: Record<string, unknown>) =>
  t.execute!({ method: "GET", ...input } as never, { toolCallId: "1", messages: [] } as never) as Promise<PaidFetchResult>;

describe("paidFetchTool", () => {
  it("the input schema has no payee, amount or network", async () => {
    const { tool } = await setup();
    const shape = (tool.inputSchema as unknown as { shape: Record<string, unknown> }).shape;
    expect(Object.keys(shape).sort()).toEqual(["body", "contentType", "method", "url"]);
  });

  it("pays a registered merchant and fences the body", async () => {
    const { tool, mock } = await setup();
    const r = await run(tool, { url: `${mock.url}/data` });
    expect(r).toMatchObject({ ok: true, status: 200, paid: { amount: "0.01", payTo: MERCHANT } });
    if (r.ok) expect(r.body).toMatch(/<untrusted_[0-9a-f]{12}>\n\{"price":42\}\n<\/untrusted_[0-9a-f]{12}>/);
    expect(mock.received).toHaveLength(1);
  });

  it("returns a refusal (not an exception) when the 402 swaps the payee", async () => {
    const { tool, mock } = await setup();
    const r = await run(tool, { url: `${mock.url}/swap` });
    expect(r).toMatchObject({ ok: false, refused: true });
    expect(mock.received).toHaveLength(0);
  });

  it("stops at the sealed plan", async () => {
    const { tool, mock } = await setup(20_000n);
    await run(tool, { url: `${mock.url}/data` });
    await run(tool, { url: `${mock.url}/data` });
    const r = await run(tool, { url: `${mock.url}/data` });
    expect(r).toMatchObject({ ok: false, refused: true });
    expect(mock.received).toHaveLength(2);
  });

  it("works inside generateText: the model calls the tool, the SDK pays, the model answers", async () => {
    const { tool, mock } = await setup();
    const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
    const model = new MockLanguageModelV4({
      doGenerate: [
        { content: [{ type: "tool-call", toolCallId: "c1", toolName: "paid_fetch", input: JSON.stringify({ url: `${mock.url}/data` }) }], finishReason: { unified: "tool-calls", raw: "tool_calls" }, usage, warnings: [] },
        { content: [{ type: "text", text: "The price is 42." }], finishReason: { unified: "stop", raw: "stop" }, usage, warnings: [] },
      ] as never,
    });
    const result = await generateText({ model, tools: { paid_fetch: tool }, prompt: "What's the price?", stopWhen: isStepCount(3) });
    expect(result.text).toBe("The price is 42.");
    expect(mock.received).toHaveLength(1);
    const call = result.steps[0]!.toolResults[0]!;
    expect((call.output as PaidFetchResult).ok).toBe(true);
  });
});
