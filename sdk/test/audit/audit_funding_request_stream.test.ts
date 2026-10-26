import { Readable } from "node:stream";
import { spawnSync } from "node:child_process";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Address, LocalAccount } from "viem";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MerchantRegistry } from "../../src/policy/registry.js";
import { createFundingService } from "../../src/wallet/fundingService.js";

type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;
const http = vi.hoisted(() => ({ handler: undefined as Handler | undefined }));

// Capture the real funding service's request callback. No socket is opened.
vi.mock("node:http", () => ({
  createServer: (handler: Handler) => {
    http.handler = handler;
    return { listen: (_port: number, _host: string, ready: () => void) => ready() };
  },
}));

const ORIGIN = "https://stream-fixture.invalid";
const ADDRESS: Address = "0x1111111111111111111111111111111111111111";
const TOKEN = "fixture-only-bearer-token";
const VALID = JSON.stringify({ origin: ORIGIN, amount: "100" });
const FAILURE = "fixture request stream interrupted";

class MemoryResponse {
  statusCode = 200;
  body = "";
  ended = false;
  writeHead = vi.fn((status: number, _headers?: Record<string, string>) => {
    this.statusCode = status;
    return this;
  });
  end = vi.fn((body = "") => {
    this.body = body;
    this.ended = true;
    return this;
  });
}

beforeEach(() => { http.handler = undefined; });

async function setup() {
  const withdraw = vi.fn(async (_to: Address, _amount: bigint) => "fixture-withdrawal");
  const payerFor = vi.fn(() => ({ address: ADDRESS }) as LocalAccount);
  const registry = new MerchantRegistry([
    { origin: ORIGIN, payTo: ADDRESS, network: "eip155:84532", maxPerTx: 1_000n },
  ]);
  const service = createFundingService({
    registry, payerFor, chainId: 84532, withdraw,
    limits: { maxPerTopUp: 1_000n, maxPerDay: 1_000n },
    now: () => 10_000,
  });
  await service.listen(0, TOKEN);
  const handler = http.handler!;
  expect(handler).toBeTypeOf("function");

  async function request(chunks: string[], options: { fail?: boolean; auth?: string; method?: string } = {}) {
    // A real Node Readable supplies ordinary chunks or a deterministic read
    // failure. The outer harness always observes rejections, keeping them out
    // of Vitest's process-level unhandled-rejection path.
    const stream = Readable.from((async function* () {
      for (const chunk of chunks) yield Buffer.from(chunk);
      if (options.fail) throw new Error(FAILURE);
    })());
    const iterate = vi.fn(() => stream[Symbol.asyncIterator]());
    const req = {
      method: options.method ?? "POST",
      headers: { authorization: options.auth ?? `Bearer ${TOKEN}` },
      [Symbol.asyncIterator]: iterate,
    } as unknown as IncomingMessage;
    const response = new MemoryResponse();
    const result = await handler(req, response as unknown as ServerResponse).then(
      () => ({ kind: "handled" as const }),
      (error: unknown) => ({ kind: "escaped" as const, error }),
    );
    return { response, result, iterate };
  }
  return { service, withdraw, payerFor, request };
}


/** Exercise this captured callback's actual body under a real node:http Server
 * in an isolated child. Reconstruct only its expected-token/topUp closure;
 * the stream-failure path never reaches topUp. The server emits a synthetic
 * request without listening. Explicit throw mode makes rejection policy clear.
 */
function dispatchInChild(handler: Handler, fail: boolean) {
  const callbackSource = handler.toString();
  // Vitest rewrites the node:crypto import to a module alias. Reconstruct that
  // dependency without modifying the callback body or suppressing its errors.
  const cryptoAliases = [...new Set([...callbackSource.matchAll(/\b(__vite_ssr_import_\d+__)\.timingSafeEqual\b/g)].map((m) => m[1]!))];
  const allAliases = [...new Set(callbackSource.match(/\b__vite_ssr_import_\d+__\b/g) ?? [])];
  expect(allAliases.every((alias) => cryptoAliases.includes(alias))).toBe(true);
  const cryptoBindings = cryptoAliases.map((alias) => `const ${alias} = require("node:crypto");`).join("\n");
  const code = `
    const { createServer } = require("node:http");
    const { Readable } = require("node:stream");
    const expected = Buffer.from(${JSON.stringify(`Bearer ${TOKEN}`)});
    const topUp = async () => ({ ok: false, reason: "fixture-only control" });
    ${cryptoBindings}
    const callback = (${callbackSource});
    const req = Readable.from((async function* () {
      for (const chunk of ${JSON.stringify(fail ? ["{"] : [VALID])}) yield Buffer.from(chunk);
      if (${JSON.stringify(fail)}) throw new Error(${JSON.stringify(FAILURE)});
    })());
    req.method = "POST";
    req.headers = { authorization: ${JSON.stringify(`Bearer ${TOKEN}`)} };
    const res = {
      statusCode: 200,
      writeHead(status) { this.statusCode = status; return this; },
      end() { process.stdout.write(String(this.statusCode)); return this; },
    };
    const server = createServer(callback);
    server.emit("request", req, res);
  `;
  return spawnSync(process.execPath, ["--unhandled-rejections=throw", "-e", code], {
    encoding: "utf8", timeout: 5_000, maxBuffer: 64 * 1_024,
  });
}

describe("funding HTTP callback contains request-body read failures", () => {
  it("rejects an invalid same-length bearer token without reading the body", async () => {
    const t = await setup();
    const r = await t.request([], { fail: true, auth: `Bearer ${TOKEN.slice(0, -1)}X` });
    expect(r.result.kind).toBe("handled");
    expect(r.response.statusCode).toBe(401);
    expect(r.iterate).not.toHaveBeenCalled();
    expect(t.withdraw).not.toHaveBeenCalled();
  });

  it("rejects a non-POST request before reading its body", async () => {
    const t = await setup();
    const r = await t.request([], { fail: true, method: "GET" });
    expect(r.result.kind).toBe("handled");
    expect(r.response.statusCode).toBe(401);
    expect(r.iterate).not.toHaveBeenCalled();
    expect(t.withdraw).not.toHaveBeenCalled();
  });

  it("handles a complete valid body with one simulated withdrawal", async () => {
    const t = await setup();
    const r = await t.request([VALID.slice(0, 10), VALID.slice(10)]);
    expect(r.result.kind).toBe("handled");
    expect(r.response.statusCode).toBe(200);
    expect(r.response.ended).toBe(true);
    expect(JSON.parse(r.response.body)).toMatchObject({ ok: true, amount: "100", ref: "fixture-withdrawal" });
    expect(t.withdraw).toHaveBeenCalledExactlyOnceWith(ADDRESS, 100n);
  });

  it("handles malformed JSON without deriving a payer or withdrawing", async () => {
    const t = await setup();
    const r = await t.request(["{"]);
    expect(r.result.kind).toBe("handled");
    expect(r.response.statusCode).toBe(400);
    expect(r.response.ended).toBe(true);
    expect(t.payerFor).not.toHaveBeenCalled();
    expect(t.withdraw).not.toHaveBeenCalled();
  });

  it("handles a finite body just beyond the limit without withdrawing", async () => {
    const t = await setup();
    const r = await t.request(["x".repeat(1_025)]);
    expect(r.result.kind).toBe("handled");
    expect(r.response.statusCode).toBe(413);
    expect(r.response.ended).toBe(true);
    expect(t.withdraw).not.toHaveBeenCalled();
  });

  it.each([
    { stage: "before the first chunk", chunks: [] as string[] },
    { stage: "after a partial body", chunks: [VALID.slice(0, 10)] },
  ])("contains a read failure $stage within the request handler", async ({ chunks }) => {
    const t = await setup();
    const r = await t.request(chunks, { fail: true });
    if (r.result.kind === "escaped") expect((r.result.error as Error).message).toBe(FAILURE);
    expect(t.payerFor).not.toHaveBeenCalled();
    expect(t.withdraw).not.toHaveBeenCalled();
    // This is the safe-behavior regression: the HTTP callback must not leak a
    // rejected promise when an authenticated request's readable stream fails.
    expect.soft(r.result.kind).toBe("handled");
    const next = await t.request([VALID]);
    expect(next.result.kind).toBe("handled");
    expect(next.response.statusCode).toBe(200);
    expect(t.withdraw).toHaveBeenCalledExactlyOnceWith(ADDRESS, 100n);
  });

  it("handles a complete request dispatched by a real HTTP server in an isolated child", async () => {
    await setup();
    const child = dispatchInChild(http.handler!, false);
    expect(child.error).toBeUndefined();
    expect(child.signal).toBeNull();
    expect(child.status).toBe(0);
    expect(child.stderr).toBe("");
    expect(child.stdout).toBe("403");
  });

  it("does not terminate an isolated HTTP-server child when an authenticated body stream fails", async () => {
    await setup();
    const child = dispatchInChild(http.handler!, true);
    expect(child.error).toBeUndefined();
    expect(child.signal).toBeNull();
    if (child.status !== 0) expect(child.stderr).toContain(`Error: ${FAILURE}`);
    expect(child.status).toBe(0);
  });
});
