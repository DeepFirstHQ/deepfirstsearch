import { afterEach, describe, expect, it } from "vitest";
import { AIMessage } from "@langchain/core/messages";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { privateKeyToAccount } from "viem/accounts";
import { createAgentPay, MerchantRegistry } from "@deepfirstsearch/agent-pay";
import { startMockServer, type MockServer } from "../../../sdk/examples/mock-x402-server.js";
import { createPaidFetchTool, refusalCode } from "../src/index.js";
// The SDK in this repository (>= 0.8.0, with refusal codes), next to the published one installed above.
import * as localSdk from "../../../sdk/src/index.js";

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
  return { tool: createPaidFetchTool({ pay, plan }), mock };
}

describe("createPaidFetchTool", () => {
  it("the schema has no payee, amount or network", async () => {
    const { tool } = await setup();
    expect(Object.keys((tool.schema as unknown as { shape: object }).shape).sort()).toEqual(["body", "contentType", "method", "url"]);
  });

  it("pays a registered merchant and fences the body", async () => {
    const { tool, mock } = await setup();
    const r = JSON.parse(await tool.invoke({ url: `${mock.url}/data` }));
    expect(r).toMatchObject({ ok: true, status: 200, paid: { amount: "0.01", payTo: MERCHANT } });
    expect(r.body).toMatch(/<untrusted_[0-9a-f]{12}>\n\{"price":42\}\n<\/untrusted_[0-9a-f]{12}>/);
    expect(mock.received).toHaveLength(1);
  });

  it("refuses a payee swap without throwing", async () => {
    const { tool, mock } = await setup();
    expect(JSON.parse(await tool.invoke({ url: `${mock.url}/swap` }))).toMatchObject({ ok: false, refused: true });
    expect(mock.received).toHaveLength(0);
  });

  it("stops at the sealed plan", async () => {
    const { tool, mock } = await setup(20_000n);
    await tool.invoke({ url: `${mock.url}/data` });
    await tool.invoke({ url: `${mock.url}/data` });
    expect(JSON.parse(await tool.invoke({ url: `${mock.url}/data` }))).toMatchObject({ ok: false, refused: true });
    expect(mock.received).toHaveLength(2);
  });

  it("runs in a LangGraph ToolNode from a model's tool call", async () => {
    const { tool, mock } = await setup();
    const node = new ToolNode([tool]);
    const out = await node.invoke({
      messages: [new AIMessage({ content: "", tool_calls: [{ id: "c1", name: "paid_fetch", args: { url: `${mock.url}/data` } }] })],
    });
    const msg = out.messages[0];
    expect(msg.tool_call_id).toBe("c1");
    expect(JSON.parse(msg.content as string)).toMatchObject({ ok: true, paid: { amount: "0.01" } });
    expect(mock.received).toHaveLength(1);
  });
});

describe("refusal codes (SDK >= 0.8.0), tolerated when absent", () => {
  it("returns the stable code and action of a real refusal: a 402 whose price moved above the pin, zero signatures", async () => {
    mock = await startMockServer({ "/data": { price: 15_000n, payTo: MERCHANT } });
    const pay = localSdk.createAgentPay({
      registry: new localSdk.MerchantRegistry([{ origin: mock.url, payTo: MERCHANT, network: "eip155:84532", maxPerTx: 20_000n, pricePin: 10_000n }]),
      policy: { allowedNetworks: ["eip155:84532"] },
      payer: () => payer,
      session: { readsUntrustedInput: true, accessesSensitiveData: false, canPay: true },
    });
    const plan = pay.commitPlan([{ origin: mock.url, maxSpend: 30_000n }], 60_000);
    const tool = createPaidFetchTool({ pay: pay as never, plan: plan as never });
    expect(JSON.parse(await tool.invoke({ url: `${mock.url}/data` }))).toEqual({
      ok: false,
      refused: true,
      reason: "payment denied: amount 15000 is above the pinned price 10000",
      code: "price_changed",
      action: "ask_owner",
    });
    expect(mock.received).toHaveLength(0);
  });

  it("omits code and action with an SDK that has no codes, and for non-refusals", () => {
    expect(refusalCode(Object.assign(new Error("payment denied: x"), { name: "PaymentDeniedError" }))).toEqual({});
    expect(refusalCode(Object.assign(new Error("boom"), { code: "econnrefused" }))).toEqual({});
    expect(refusalCode(Object.assign(new Error("x"), { name: "PaymentDeniedError", code: "bad code!", action: "report" }))).toEqual({});
    expect(refusalCode(Object.assign(new Error("x"), { name: "PaymentDeniedError", code: "payee_mismatch", action: "report" }))).toEqual({ code: "payee_mismatch", action: "report" });
  });
});
