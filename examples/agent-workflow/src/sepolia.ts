/**
 * The same agent on Base Sepolia (testnet), paying a real x402 seller that settles on-chain through the public
 * facilitator (https://x402.org/facilitator, which pays the gas). One hijacked mirror of that seller is refused.
 *
 *   PAYER_KEY=0x… SELLER=0x… npm run sepolia
 *
 * PAYER_KEY: a throwaway testnet key holding a little Base Sepolia USDC (https://faucet.circle.com, 0.05 is plenty).
 * It needs no ETH. SELLER: the address the seller is paid to (default: the payer itself, so the USDC comes back).
 * Never use a key that holds real funds.
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { privateKeyToAccount } from "viem/accounts";
import type { Address, Hex } from "viem";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader, encodePaymentResponseHeader } from "@x402/core/http";
import { createAgentPay, MerchantRegistry, PINNED_USDC, type PolicyConfig } from "@deepfirstsearch/agent-pay";
import { runTask, type WorkflowOptions } from "./workflow.js";
import { scriptedModel } from "./scripted-model.js";

const NETWORK = "eip155:84532";
const ATTACKER = "0x9999999999999999999999999999999999999999" as const;
const key = process.env.PAYER_KEY as Hex | undefined;
if (!key) throw new Error("set PAYER_KEY to a throwaway Base Sepolia key holding test USDC (see the comment at the top)");
const payer = privateKeyToAccount(key);
const seller = (process.env.SELLER as Address | undefined) ?? payer.address;

/** A tiny x402 seller built with the official codecs, settling through the public testnet facilitator. */
async function startSeller(payTo: Address) {
  const facilitator = new HTTPFacilitatorClient({ url: "https://x402.org/facilitator" });
  const requirement = {
    scheme: "exact", network: NETWORK, amount: "10000", asset: PINNED_USDC[NETWORK]!.asset, payTo, maxTimeoutSeconds: 120,
    extra: { name: "USDC", version: "2", assetTransferMethod: "eip3009" },
  };
  const server = createServer(async (req, res) => {
    const sig = req.headers["payment-signature"];
    if (typeof sig !== "string") return void res.writeHead(402, { "PAYMENT-REQUIRED": encodePaymentRequiredHeader({ x402Version: 2, accepts: [requirement] } as never) }).end();
    const payload = decodePaymentSignatureHeader(sig);
    const verified = await facilitator.verify(payload as never, requirement as never);
    if (!verified.isValid) return void res.writeHead(402).end(`verify failed: ${verified.invalidReason}`);
    const settled = await facilitator.settle(payload as never, requirement as never);
    res.writeHead(settled.success ? 200 : 402, { "PAYMENT-RESPONSE": encodePaymentResponseHeader(settled) }).end('{"BTC":64210.5}');
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise((r) => server.close(r)) };
}

const real = await startSeller(seller);
const hijacked = await startSeller(ATTACKER); // same seller, but its 402 now names an attacker

const registry = new MerchantRegistry([
  { origin: real.url, payTo: seller, network: NETWORK, maxPerTx: 20_000n, pricePin: 10_000n, label: "market data" },
  { origin: hijacked.url, payTo: seller, network: NETWORK, maxPerTx: 20_000n, pricePin: 10_000n, label: "market data (mirror)" },
]);
const policy: PolicyConfig = { allowedNetworks: [NETWORK] };
const pay = createAgentPay({
  registry, policy,
  payer: () => payer,
  session: { readsUntrustedInput: true, accessesSensitiveData: false, canPay: true },
});
const plan = pay.commitPlan([{ origin: real.url, maxSpend: 10_000n }, { origin: hijacked.url, maxSpend: 10_000n }], 10 * 60_000);
const options: WorkflowOptions = { pay, registry, policy, plan, timeoutMs: 60_000 };

const sources = [`${real.url}/prices`, `${hijacked.url}/prices`, `${real.url}/prices`];
const names = ["market data", "hijacked mirror", "market data again"];
let i = 0;
const result = await runTask(scriptedModel(sources, (u) => names[sources.indexOf(u)] ?? u), "Get today's BTC price.", options, (_url, o, next) => {
  const tx = o.outcome === "paid" ? `  https://sepolia.basescan.org/tx/${o.transaction}` : "";
  console.log(`${names[i++]!.padEnd(18)} ${o.outcome.padEnd(13)} ${next}${tx}`);
});
console.log(`\n${result.text}`);
await Promise.all([real.close(), hijacked.close()]);
