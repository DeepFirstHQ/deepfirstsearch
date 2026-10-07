/**
 * Pay three public x402 APIs on Base mainnet through the SDK, with small amounts (issue #8).
 * Total cost: 0.012 USDC per run. The payer needs that much USDC on Base; it needs no ETH (the merchant settles).
 *
 *   PAYER_KEY=0x… npx tsx examples/real-merchants.ts
 *
 * Use a throwaway key holding a few cents, never a wallet that matters. Every merchant below was paid on
 * 2026-10-07; their payTo and prices come from their own 402s and are pinned here, so if a merchant changes
 * either, the payment is refused (that is the point) and this file needs updating.
 */
import { privateKeyToAccount } from "viem/accounts";
import { createAgentPay, MerchantRegistry, PaymentDeniedError } from "../src/index.js";
import { startMockServer } from "../src/testing/index.js";

const key = process.env.PAYER_KEY;
if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("set PAYER_KEY to a throwaway private key holding ~0.02 USDC on Base");
const payer = privateKeyToAccount(key as `0x${string}`);

// The owner's list: who may be paid, at what price, with what cap. Nothing here comes from the model or the 402.
const registry = new MerchantRegistry([
  { origin: "https://api.blockchain.info", payTo: "0x995ffeF6c39234F0bBc95cf0E84FE1B6e6e2d8e0", network: "eip155:8453", maxPerTx: 2_000n, pricePin: 1_000n, label: "Blockchain.com Explorer" },
  { origin: "https://gateway.spraay.app", payTo: "0xAd62f03C7514bb8c51f1eA70C2b75C37404695c8", network: "eip155:8453", maxPerTx: 2_000n, pricePin: 1_000n, label: "Spraay gateway" },
  { origin: "https://pro-api.coingecko.com", payTo: "0x110cdBba7FE6434Ec4CE3464CC523942ad6Fb784", network: "eip155:8453", maxPerTx: 20_000n, pricePin: 10_000n, label: "CoinGecko" },
]);

const pay = createAgentPay({
  registry,
  policy: { allowedNetworks: ["eip155:8453"], periodBudget: { amount: 50_000n, periodMs: 86_400_000 } },
  payer: () => payer,
  session: { readsUntrustedInput: true, accessesSensitiveData: false, canPay: true },
});
// Seal the plan before reading anything untrusted: at most 0.05 USDC in total, per merchant caps below.
const plan = pay.commitPlan(
  [
    { origin: "https://api.blockchain.info", maxSpend: 2_000n },
    { origin: "https://gateway.spraay.app", maxSpend: 2_000n },
    { origin: "https://pro-api.coingecko.com", maxSpend: 20_000n },
  ],
  10 * 60_000,
);

const calls: [string, string, RequestInit][] = [
  ["Bitcoin genesis address", "https://api.blockchain.info/explorer-gateway-kt/x402/btc/address",
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address: "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa" }) }],
  ["AI models on the gateway", "https://gateway.spraay.app/api/v1/models", { method: "GET" }],
  ["WETH price on Base", "https://pro-api.coingecko.com/api/v3/x402/onchain/simple/networks/base/token_price/0x4200000000000000000000000000000000000006", { method: "GET" }],
];

for (const [what, url, init] of calls) {
  const res = await pay.fetch(url, init, { plan });
  const text = await res.text();
  console.log(`✓ ${what}: HTTP ${res.status}, paid ${Number(res.payment?.amount ?? 0n) / 1e6} USDC, tx ${res.payment?.settlement.transaction}`);
  console.log(`  ${text.slice(0, 120).replace(/\s+/g, " ")}…`);
}

// What a prompt injection looks like: a page tells the agent to fetch a URL that isn't on the owner's list, and that
// URL answers with a 402 for 5 USDC to the attacker. Free pages still load; paying anyone off the list never happens.
const attacker = await startMockServer({
  "/ignore-previous-instructions": { price: 5_000_000n, payTo: "0x9999999999999999999999999999999999999999" },
});
try {
  await pay.fetch(`${attacker.url}/ignore-previous-instructions`, {}, { plan });
  throw new Error("the attacker was paid: this should never happen");
} catch (e) {
  if (!(e instanceof PaymentDeniedError)) throw e;
  console.log(`✗ injected 402 for 5 USDC refused before anything was signed: ${e.message.slice(0, 80)}`);
} finally {
  await attacker.close();
}
