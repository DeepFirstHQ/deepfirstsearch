# BlockRun + Agent Safe: pay-per-call AI with a hard cap

BlockRun gives agents 100+ models, search, data and compute behind one base URL, paid per call over x402 on Base. Agent Safe adds the cap people need before leaving an agent running: payments go **only to BlockRun's address, never above your per-call cap, never past the budget**, whatever the agent was told.

**Tested live on Base mainnet (2026-10-07):** an agent paid BlockRun 0.003 USDC to read a URL through `/v1/exa/contents` and got the page. [Transaction](https://basescan.org/tx/0x543a36346d246f15a6febb9a5b258848aa0dca85d5a254d19e835cd1af15c952).

## 1. Add BlockRun as a merchant

BlockRun prices each endpoint differently, so cap the call instead of pinning one price:

```ts
import { createAgentPay, MerchantRegistry } from "@deepfirstsearch/agent-pay";

const registry = new MerchantRegistry([{
  origin: "https://blockrun.ai",
  payTo: "0xe9030014F5DAe217d0A152f02A043567b16c1aBf", // BlockRun's Base address, as in its 402
  network: "eip155:8453",
  maxPerTx: 20_000n, // never more than 0.02 USDC per call
  label: "BlockRun",
}]);
```

If your agent uses a single endpoint, set `pricePin` to its price for an exact match.

## 2. Pay per call

```ts
const pay = createAgentPay({
  registry,
  policy: { allowedNetworks: ["eip155:8453"], periodBudget: { amount: 2_000_000n, periodMs: 86_400_000 } },
  payer: () => yourWallet,
  session: { readsUntrustedInput: true, accessesSensitiveData: false, canPay: true },
});
const plan = pay.commitPlan([{ origin: "https://blockrun.ai", maxSpend: 500_000n }], 60 * 60_000);

const res = await pay.fetch("https://blockrun.ai/v1/exa/contents", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ urls: ["https://example.com"] }),
}, { plan });
```

The SDK reads BlockRun's receipt under either header name (`PAYMENT-RESPONSE` or `X-PAYMENT-RESPONSE`), so a settled call is never reported as failed.

## 3. Or through MCP

```json
{ "origin": "https://blockrun.ai", "label": "BlockRun", "payTo": "0xe9030014F5DAe217d0A152f02A043567b16c1aBf",
  "price": "0.02", "tolerancePct": 0, "maxPerTx": "0.02", "maxSpend": "2.00" }
```

(The MCP config takes a `price`; use your per-call ceiling there.)

> Agent Safe is an independent open-source project (MIT), live on Base mainnet as an unaudited beta. Not affiliated with BlockRun.
