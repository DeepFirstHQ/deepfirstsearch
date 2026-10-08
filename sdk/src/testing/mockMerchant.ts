import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { verifyTypedData, type Address } from "viem";
import { decodeHeader, encodeHeader } from "../x402/codec.js";
import { TRANSFER_WITH_AUTHORIZATION_TYPES, usdcDomain } from "../x402/exactEvm.js";
import {
  caip2ToV1Network,
  PaymentPayload,
  PaymentPayloadV1,
  type PaymentRequired,
  type PaymentRequiredV1,
  type PaymentRequirements,
  type PaymentRequirementsV1,
} from "../x402/schemas.js";
import { PINNED_USDC } from "../policy/networks.js";

/**
 * A local x402 resource server plus facilitator, for tests and the demo. Speaks v2 by default; a route with
 * `x402Version: 1` speaks v1 (402 as a JSON body, `X-PAYMENT` in, `X-PAYMENT-RESPONSE` out). Each route can behave honestly or like
 * an attacker (swapping the payee, the asset, the price...). It verifies signatures the way a facilitator would.
 */
export type Route = {
  price: bigint;
  payTo: Address;
  /** Optional tampering applied to the 402 the server sends. */
  tamper?: (r: PaymentRequirements) => PaymentRequirements;
  body?: string;
  /** Send the receipt under the x402 v1 header name (X-PAYMENT-RESPONSE), like some live merchants. */
  legacyReceipt?: boolean;
  /** Behave like Coinbase-facilitated merchants (e.g. CoinGecko): reject payloads without the 402's `resource`, and
   * send `errorReason: null` in a successful receipt. */
  cdpStyle?: boolean;
  /** Send this value as the receipt instead of a real settlement (e.g. Robtex's {settled: true, method: "direct"}). */
  rawReceipt?: unknown;
  /** Speak x402 v1 on this route (like Heurist Mesh or Browserbase): 402 in the body, `X-PAYMENT`, `X-PAYMENT-RESPONSE`.
   * `tamper` still applies, to the v2-shaped requirement before it is converted to v1. */
  x402Version?: 1 | 2;
  /** v1 only: rewrite the whole v1 402 body before it is sent (e.g. add a Solana option or an unknown network). */
  tamperV1?: (body: PaymentRequiredV1) => unknown;
};

export type MockServer = {
  url: string;
  received: PaymentPayload[];
  /** x402 v1 payloads received on `x402Version: 1` routes (kept apart so `received` stays v2-typed). */
  receivedV1: PaymentPayloadV1[];
  close: () => Promise<void>;
};

/**
 * Starts the mock merchant. It speaks Base Sepolia (`eip155:84532`) by default; pass `{ network: "eip155:8453" }` to
 * match code written for Base mainnet. Either way nothing touches a chain: signatures are verified locally.
 */
export async function startMockServer(routes: Record<string, Route>, opts: { network?: string } = {}): Promise<MockServer> {
  const NETWORK = opts.network ?? "eip155:84532";
  if (!PINNED_USDC[NETWORK]) throw new Error(`no pinned USDC for ${NETWORK}`);
  const received: PaymentPayload[] = [];
  const receivedV1: PaymentPayloadV1[] = [];
  const V1_NETWORK = caip2ToV1Network(NETWORK);
  const asset = PINNED_USDC[NETWORK]!;

  const server: Server = createServer(async (req, res) => {
    const route = routes[req.url ?? ""];
    if (!route) {
      res.writeHead(404).end();
      return;
    }
    const requirement: PaymentRequirements = (route.tamper ?? ((r) => r))({
      scheme: "exact",
      network: NETWORK,
      amount: route.price.toString(),
      asset: asset.asset,
      payTo: route.payTo,
      maxTimeoutSeconds: 60,
      extra: { name: asset.domain.name, version: asset.domain.version, assetTransferMethod: "eip3009" },
    });

    if (route.x402Version === 1) {
      await serveV1(route, requirement, req.url ?? "/", req.headers["x-payment"], res);
      return;
    }

    const sig = req.headers["payment-signature"];
    if (typeof sig !== "string") {
      const required: PaymentRequired = {
        x402Version: 2,
        resource: { url: req.url ?? "/", description: "market data", mimeType: "application/json" },
        accepts: [requirement],
      };
      res.writeHead(402, { "PAYMENT-REQUIRED": encodeHeader(required) }).end();
      return;
    }

    const payload = decodeHeader(sig, PaymentPayload);
    received.push(payload);
    const { authorization, signature } = payload.payload;
    const valid = await verifyAuthorization(authorization, signature);
    const paidEnough = BigInt(authorization.value) >= route.price && (!route.cdpStyle || payload.resource !== undefined);
    const settlement = {
      success: valid && paidEnough,
      payer: authorization.from,
      transaction: valid ? `0x${"ab".repeat(32)}` : "",
      network: NETWORK,
      ...(valid && paidEnough ? (route.cdpStyle ? { errorReason: null } : {}) : { errorReason: valid ? "insufficient_amount" : "invalid_signature" }),
    };
    res.writeHead(valid && paidEnough ? 200 : 402, { [route.legacyReceipt ? "X-PAYMENT-RESPONSE" : "PAYMENT-RESPONSE"]: encodeHeader(route.rawReceipt ?? settlement), "Content-Type": "application/json" });
    res.end(route.body ?? JSON.stringify({ ok: true }));
  });

  async function verifyAuthorization(authorization: PaymentPayload["payload"]["authorization"], signature: string): Promise<boolean> {
    return verifyTypedData({
      address: authorization.from as Address,
      domain: usdcDomain(asset),
      types: TRANSFER_WITH_AUTHORIZATION_TYPES,
      primaryType: "TransferWithAuthorization",
      message: {
        from: authorization.from as Address,
        to: authorization.to as Address,
        value: BigInt(authorization.value),
        validAfter: BigInt(authorization.validAfter),
        validBefore: BigInt(authorization.validBefore),
        nonce: authorization.nonce as `0x${string}`,
      },
      signature: signature as `0x${string}`,
    });
  }

  async function serveV1(route: Route, r: PaymentRequirements, path: string, sig: string | string[] | undefined, res: ServerResponse) {
    if (!V1_NETWORK) throw new Error(`no x402 v1 name for ${NETWORK}`);
    if (typeof sig !== "string") {
      const option: PaymentRequirementsV1 = {
        scheme: r.scheme,
        network: caip2ToV1Network(r.network) ?? r.network,
        maxAmountRequired: r.amount,
        resource: `http://127.0.0.1${path}`,
        description: "market data",
        mimeType: "application/json",
        payTo: r.payTo,
        maxTimeoutSeconds: r.maxTimeoutSeconds,
        asset: r.asset,
        ...(r.extra ? { extra: { name: r.extra.name, version: r.extra.version } } : {}),
      };
      const body: PaymentRequiredV1 = { x402Version: 1, error: "X-PAYMENT header is required", accepts: [option] };
      res.writeHead(402, { "Content-Type": "application/json" }).end(JSON.stringify(route.tamperV1 ? route.tamperV1(body) : body));
      return;
    }
    const payload = decodeHeader(sig, PaymentPayloadV1);
    receivedV1.push(payload);
    const { authorization, signature } = payload.payload;
    const valid = payload.network === V1_NETWORK && (await verifyAuthorization(authorization, signature));
    const paidEnough = BigInt(authorization.value) >= route.price;
    const ok = valid && paidEnough;
    const settlement = {
      success: ok,
      payer: authorization.from,
      transaction: valid ? `0x${"ab".repeat(32)}` : "",
      network: V1_NETWORK,
      ...(ok ? {} : { errorReason: valid ? "insufficient_amount" : "invalid_signature" }),
    };
    res.writeHead(ok ? 200 : 402, { "X-PAYMENT-RESPONSE": encodeHeader(route.rawReceipt ?? settlement), "Content-Type": "application/json" });
    res.end(route.body ?? JSON.stringify({ ok: true }));
  }

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    received,
    receivedV1,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
