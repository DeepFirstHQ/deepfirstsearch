# CoinGecko + Agent Safe: price data for agents, inside a budget

CoinGecko serves onchain DEX prices and market data to agents over x402, paid per call in USDC on Base. Agent Safe adds the guardrail people need before leaving an agent running: payments go **only to CoinGecko's address, never above your per-call cap, never past the budget**, whatever the agent was told.

**Tested live on Base mainnet (2026-10-07):** an agent paid CoinGecko 0.01 USDC for `GET /api/v3/x402/onchain/simple/networks/base/token_price/0x4200000000000000000000000000000000000006` and got the live WETH price on Base. [Transaction](https://basescan.org/tx/0x624f3c76021ccc4f17d86143365e8e235ac90271f0424738b56c1fec132a76b0). The same 402 checked against a different payee was refused with zero signatures.

## 1. Add CoinGecko as a merchant

```ts
import { createAgentPay, MerchantRegistry } from "@deepfirstsearch/agent-pay";

const registry = new MerchantRegistry([{
  origin: "https://pro-api.coingecko.com",
  payTo: "0x110cdBba7FE6434Ec4CE3464CC523942ad6Fb784", // CoinGecko's Base address, as in its 402
  network: "eip155:8453",
  maxPerTx: 20_000n, // never more than 0.02 USDC per call
  pricePin: 10_000n, // 0.01 USDC, the published price
  label: "CoinGecko",
}]);
```

## 2. Pay per call

```ts
const pay = createAgentPay({
  registry,
  policy: { allowedNetworks: ["eip155:8453"], periodBudget: { amount: 1_000_000n, periodMs: 86_400_000 } },
  payer: () => yourWallet, // any viem account: local key, Turnkey, Privy, CDP, KMS
  session: { readsUntrustedInput: true, accessesSensitiveData: false, canPay: true },
});
const plan = pay.commitPlan([{ origin: "https://pro-api.coingecko.com", maxSpend: 100_000n }], 60 * 60_000);

const res = await pay.fetch("https://pro-api.coingecko.com/api/v3/x402/onchain/simple/networks/base/token_price/0x4200000000000000000000000000000000000006", { method: "GET" }, { plan });
console.log(res.status, res.payment?.settlement.transaction);
```

A 402 that asks for a different payee, a higher price or a different network is refused before anything is signed. Requires `@deepfirstsearch/agent-pay` 0.5.3 or later.

## 3. Or through MCP (Claude, Cursor, OpenClaw)

Add to the merchants of your [agent-pay-mcp](https://github.com/DeepFirstHQ/deepfirstsearch/tree/main/integrations/mcp) config, then ask the agent to use `https://pro-api.coingecko.com/api/v3/x402/onchain/simple/networks/base/token_price/0x4200000000000000000000000000000000000006`:

```json
{ "origin": "https://pro-api.coingecko.com", "label": "CoinGecko", "payTo": "0x110cdBba7FE6434Ec4CE3464CC523942ad6Fb784",
  "price": "0.01", "maxPerTx": "0.02", "maxSpend": "1.00" }
```

Source, issues and the full SDK: [github.com/DeepFirstHQ/deepfirstsearch](https://github.com/DeepFirstHQ/deepfirstsearch). Questions or a merchant you'd like covered: [Discussions](https://github.com/DeepFirstHQ/deepfirstsearch/discussions).

> Agent Safe is an independent open-source project (MIT), live on Base mainnet as an unaudited beta. Not affiliated with CoinGecko.
