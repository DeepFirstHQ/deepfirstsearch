import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentPay } from "../../src/x402/client.js";
import { MerchantRegistry } from "../../src/policy/registry.js";
import { PaymentBlockedError, PaymentDeniedError } from "../../src/guard/controls.js";
import { MERCHANT_PAYTO, NETWORK, ORIGIN, payer, policy, requirement } from "../fixtures.js";
import { fakeNet, mkPay, ok, req402, resp, safeSession } from "./helpers.js";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

async function serve(host: string, h: (req: IncomingMessage, res: ServerResponse) => void): Promise<string> {
  const s = createServer(h);
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  return `http://${host}:${(s.address() as AddressInfo).port}`;
}

function agent(origin: string) {
  const registry = new MerchantRegistry([{ origin, payTo: MERCHANT_PAYTO, network: NETWORK, maxPerTx: 1_000_000n, pricePin: 10_000n }]);
  const pay = createAgentPay({ registry, policy, payer: () => payer, session: safeSession });
  const plan = pay.commitPlan([{ origin, maxSpend: 100_000n }], 60_000);
  return { pay, plan };
}

describe("regression S-01: 402 via redirect on the unpaid request", () => {
  it("denies a 402 served by another origin after a 302", async () => {
    let bHits = 0;
    const b = await serve("localhost", (_req, res) => {
      bHits++;
      res.writeHead(402, req402([requirement()])).end();
    });
    const a = await serve("127.0.0.1", (_req, res) => res.writeHead(302, { Location: `${b}/x` }).end());
    const { pay, plan } = agent(a);
    await expect(pay.fetch(`${a}/data`, {}, { plan })).rejects.toBeInstanceOf(PaymentDeniedError);
    expect(bHits).toBe(1);
  });

  it("allows a same-origin relative redirect", async () => {
    let paid = 0;
    const a = await serve("127.0.0.1", (req, res) => {
      if (req.url === "/data") return res.writeHead(302, { Location: "/v2/data" }).end();
      if (req.headers["payment-signature"]) {
        paid++;
        return res.writeHead(200, { "PAYMENT-RESPONSE": ok() }).end("ok");
      }
      res.writeHead(402, req402()).end();
    });
    const { pay, plan } = agent(a);
    const r = await pay.fetch(`${a}/data`, {}, { plan });
    expect(r.status).toBe(200);
    expect(paid).toBe(1);
  });
});

describe("SDK-L-2 the PAID request never follows redirects", () => {
  it("refuses a 3xx on the paid request; the signature never reaches a third origin", async () => {
    let leaked: string | undefined;
    let bHits = 0;
    const b = await serve("localhost", (req, res) => {
      bHits++;
      leaked = req.headers["payment-signature"] as string | undefined;
      res.writeHead(200, { "PAYMENT-RESPONSE": ok() }).end("attacker content");
    });
    const a = await serve("127.0.0.1", (req, res) => {
      if (req.headers["payment-signature"]) return res.writeHead(307, { Location: `${b}/steal` }).end();
      res.writeHead(402, req402()).end();
    });
    const { pay, plan } = agent(a);
    const err = await pay.fetch(`${a}/data`, {}, { plan }).catch((e) => e);
    expect(err).toBeInstanceOf(PaymentBlockedError);
    expect(err.message).toMatch(/redirect \(HTTP 307\) refused/);
    expect(leaked).toBeUndefined();
    expect(bHits).toBe(0);
    expect(pay.audit.entries.map((e) => e.event.type)).not.toContain("payment.settled");
  });

  it("sends the paid request with redirect: 'manual'", async () => {
    const net = fakeNet();
    const { pay, plan } = mkPay(net);
    await pay.fetch(`${ORIGIN}/a`, {}, { plan });
    const paid = net.sent.filter((s) => s.payload);
    expect(paid).toHaveLength(1);
    expect(paid[0]!.init.redirect).toBe("manual");
  });
});

describe("SDK-I-3 redirect check fails closed when the fetch implementation leaves Response.url empty", () => {
  it("a redirected 402 with url '' is denied as coming from an unknown origin", async () => {
    const registry = new MerchantRegistry([{ origin: "https://api.pricing-intel.io", payTo: MERCHANT_PAYTO, network: NETWORK, maxPerTx: 1_000_000n, pricePin: 10_000n }]);
    let signed = 0;
    const f = (async (_u: string, init: RequestInit = {}) => {
      if (new Headers(init.headers).get("PAYMENT-SIGNATURE")) {
        signed++;
        return resp(200, { "PAYMENT-RESPONSE": ok() }, "");
      }
      return resp(402, req402(), "", true); // redirected=true, url unknown
    }) as unknown as typeof fetch;
    const pay = createAgentPay({ registry, policy, payer: () => payer, session: safeSession, fetch: f });
    const plan = pay.commitPlan([{ origin: "https://api.pricing-intel.io", maxSpend: 100_000n }], 60_000);
    const err = await pay.fetch("https://api.pricing-intel.io/x", {}, { plan }).catch((e) => e);
    expect(err).toBeInstanceOf(PaymentDeniedError);
    expect(err.message).toMatch(/unknown origin/);
    expect(signed).toBe(0);
    expect(pay.audit.entries.map((e) => e.event.type)).toContain("payment.denied");
  });
});
