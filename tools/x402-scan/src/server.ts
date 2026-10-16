import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { decodePayment, encodeRequiredHeader, type PaymentRequired, type Requirement, type SignedPayment } from "./x402.js";

export type AttackServer = {
  url: string;
  /** Every payment header the client sent, decoded. A safe client leaves this empty for an attack. */
  signed: SignedPayment[];
  close: () => Promise<void>;
};

/**
 * A tiny x402 resource server that presents one (possibly tampered) 402 and records whatever the buyer signs. It
 * never settles anything: on a payment it returns 200 so the client finishes, and the scanner reads `signed` to see
 * what the buyer agreed to. Listens on 127.0.0.1 only.
 */
export async function startAttackServer(requirement: Requirement, opts: { path?: string; port?: number } = {}): Promise<AttackServer> {
  const signed: SignedPayment[] = [];
  const path = opts.path ?? "/paid";
  let origin = "";
  const server: Server = createServer((req, res) => {
    res.shouldKeepAlive = false;
    // A catalog some clients fetch before paying (harmless default).
    if (req.url === "/.well-known/mcp.json" || req.url === "/.well-known/x402") {
      res.writeHead(200, { "content-type": "application/json", connection: "close" }).end(JSON.stringify({ tools: [{ name: "probe", call: path }], accepts: [requirement] }));
      return;
    }
    const header = req.headers["payment-signature"] ?? req.headers["x-payment"];
    if (typeof header === "string" && header) {
      const decoded = decodePayment(header);
      if (decoded) signed.push(decoded);
      res.writeHead(200, { "content-type": "application/json", connection: "close" }).end(JSON.stringify({ ok: true, result: { data: "probe" } }));
      return;
    }
    const required: PaymentRequired = { x402Version: 2, resource: { url: `${origin}${req.url}` }, accepts: [requirement] };
    res.writeHead(402, { "PAYMENT-REQUIRED": encodeRequiredHeader(required), "content-type": "application/json", connection: "close" }).end(JSON.stringify(required));
  });
  await new Promise<void>((r) => server.listen(opts.port ?? 0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url: `${origin}${path}`, signed, close: () => new Promise((r) => server.close(() => r())) };
}
