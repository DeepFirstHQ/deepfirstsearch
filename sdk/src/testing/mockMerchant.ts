import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { verifyTypedData, type Address } from "viem";
import { decodeHeader, encodeHeader } from "../x402/codec.js";
import { TRANSFER_WITH_AUTHORIZATION_TYPES, usdcDomain } from "../x402/exactEvm.js";
import { PaymentPayload, type PaymentRequired, type PaymentRequirements } from "../x402/schemas.js";
import { PINNED_USDC } from "../policy/networks.js";

/**
 * A local x402 v2 resource server plus facilitator, for tests and the demo. Each route can behave honestly or like
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
};

export type MockServer = {
  url: string;
  received: PaymentPayload[];
  close: () => Promise<void>;
};

const NETWORK = "eip155:84532";

export async function startMockServer(routes: Record<string, Route>): Promise<MockServer> {
  const received: PaymentPayload[] = [];
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
    const valid = await verifyTypedData({
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
    const paidEnough = BigInt(authorization.value) >= route.price && (!route.cdpStyle || payload.resource !== undefined);
    const settlement = {
      success: valid && paidEnough,
      payer: authorization.from,
      transaction: valid ? `0x${"ab".repeat(32)}` : "",
      network: NETWORK,
      ...(valid && paidEnough ? (route.cdpStyle ? { errorReason: null } : {}) : { errorReason: valid ? "insufficient_amount" : "invalid_signature" }),
    };
    res.writeHead(valid && paidEnough ? 200 : 402, { [route.legacyReceipt ? "X-PAYMENT-RESPONSE" : "PAYMENT-RESPONSE"]: encodeHeader(settlement), "Content-Type": "application/json" });
    res.end(route.body ?? JSON.stringify({ ok: true }));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    received,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
