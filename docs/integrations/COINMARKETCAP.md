# CoinMarketCap + Agent Safe: market data for agents, inside a budget

CoinMarketCap serves crypto and DEX market data to agents over x402, paid per call in USDC on Base. Agent Safe adds the guardrail people need before leaving an agent running: payments go **only to CoinMarketCap's address, never above your per-call cap, never past the budget**, whatever the agent was told.

**Tested live on Base mainnet (2026-10-08):** an agent paid CoinMarketCap 0.01 USDC for `GET /x402/v1/dex/search?q=weth` and got live DEX search results for WETH. [Transaction](https://basescan.org/tx/0xb4d1744d5ad4488548f6f1cc07773562a402c5cfe5cae5919e06e60ff38218cc). The same 402 checked against a different payee was refused with zero signatures.

## 1. Add CoinMarketCap as a merchant

```ts
import { createAgentPay, MerchantRegistry } from "@deepfirstsearch/agent-pay";

const registry = new MerchantRegistry([{
  origin: "https://pro-api.coinmarketcap.com",
  payTo: "0x3C5f3a6cE224BB89D72f5EB4232ecC27F67B3eeA", // CoinMarketCap's Base address, as in its 402
  network: "eip155:8453",
  maxPerTx: 20_000n, // never more than 0.02 USDC per call
  pricePin: 10_000n, // 0.01 USDC, the published price
  label: "CoinMarketCap",
}]);
```

## 2. Pay per call

```ts
import { usdcAuthorizationCheck } from "@deepfirstsearch/agent-pay";
import { createPublicClient, http } from "viem";
import { base } from "viem/chains";

const pay = createAgentPay({
  registry,
  policy: { allowedNetworks: ["eip155:8453"], periodBudget: { amount: 1_000_000n, periodMs: 86_400_000 } },
  payer: () => yourWallet, // any viem account: local key, Turnkey, Privy, CDP, KMS
  // CoinMarketCap's receipt is not in the standard x402 form, so the SDK confirms the payment with USDC on-chain:
  confirmAuthorization: usdcAuthorizationCheck({ "eip155:8453": createPublicClient({ chain: base, transport: http() }) }),
  session: { readsUntrustedInput: true, accessesSensitiveData: false, canPay: true },
});
const plan = pay.commitPlan([{ origin: "https://pro-api.coinmarketcap.com", maxSpend: 100_000n }], 60 * 60_000);

const res = await pay.fetch("https://pro-api.coinmarketcap.com/x402/v1/dex/search?q=weth", { method: "GET" }, { plan });
console.log(res.status, res.payment?.confirmedOnChain ? "confirmed on-chain" : res.payment?.settlement.transaction);
```

A 402 that asks for a different payee, a higher price or a different network is refused before anything is signed. Requires `@deepfirstsearch/agent-pay` 0.6.3 or later.

## 3. Or through MCP (Claude, Cursor, OpenClaw)

Add to the merchants of your [agent-pay-mcp](https://github.com/DeepFirstHQ/deepfirstsearch/tree/main/integrations/mcp) config, then ask the agent to use `https://pro-api.coinmarketcap.com/x402/v1/dex/search?q=weth`:

```json
{ "origin": "https://pro-api.coinmarketcap.com", "label": "CoinMarketCap", "payTo": "0x3C5f3a6cE224BB89D72f5EB4232ecC27F67B3eeA",
  "price": "0.01", "maxPerTx": "0.02", "maxSpend": "1.00" }
```

CoinMarketCap's receipt is non-standard; `confirmOnChain` (on by default) checks the authorization on-chain, so the paid response is returned instead of being resent. Before paying, the agent can call `check_price` on the same URL to see the price and payee it would pay (agent-pay-mcp 0.4.0 or later).

## If CoinMarketCap changes its price or address

The pins are deliberate. The 402 is written by the server, and a 402 that suddenly names another address or a higher price is exactly what a redirected or hijacked payment looks like. So when CoinMarketCap reprices or rotates its wallet, Agent Safe refuses and nothing is signed:
- a higher price gives `price_changed` (action `ask_owner`), or `over_cap` if it is also above your per-call cap;
- a different address gives `payee_mismatch` (action `report`).

Confirm the change through CoinMarketCap's own channels (its site, docs or announcement), then update `pricePin` or `payTo` in the registry, or `price` or `payTo` in the MCP config. To absorb small price changes without a prompt, allow a tolerance instead of removing the pin: `toleranceBps` in the registry (1000 = up to 10% over the pin) or `tolerancePct` in the MCP config.

> Agent Safe is an independent open-source project (MIT), live on Base mainnet as an unaudited beta. Not affiliated with CoinMarketCap.
