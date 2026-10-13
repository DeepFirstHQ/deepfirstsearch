# Massive + Agent Safe: market data for agents, inside a budget

Massive (formerly Polygon.io) serves market data to agents over x402, paid per call in USDC on Base. Agent Safe adds the guardrail people need before leaving an agent running: payments go **only to Massive's address, never above your per-call cap, never past the budget**, whatever the agent was told.

**Tested live on Base mainnet (2026-10-07):** an agent paid Massive 0.01 USDC for `GET /v3/reference/tickers/AAPL` and got the AAPL ticker reference data. [Transaction](https://basescan.org/tx/0x7a09ffaa39dbfd610a9ad1bad0cc7b6ca39355497196e71843d7e561caaea12d). The same 402 checked against a different payee was refused with zero signatures.

## 1. Add Massive as a merchant

```ts
import { createAgentPay, MerchantRegistry } from "@deepfirstsearch/agent-pay";

const registry = new MerchantRegistry([{
  origin: "https://agent.massive.com",
  payTo: "0x525f6dDcE9aF7a7179D7696aaBfCd5FCd15a21e6", // Massive's Base address, as in its 402
  network: "eip155:8453",
  maxPerTx: 20_000n, // never more than 0.02 USDC per call
  pricePin: 10_000n, // 0.01 USDC, the published price
  label: "Massive",
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
const plan = pay.commitPlan([{ origin: "https://agent.massive.com", maxSpend: 100_000n }], 60 * 60_000);

const res = await pay.fetch("https://agent.massive.com/v3/reference/tickers/AAPL", { method: "GET" }, { plan });
console.log(res.status, res.payment?.settlement.transaction);
```

A 402 that asks for a different payee, a higher price or a different network is refused before anything is signed. Requires `@deepfirstsearch/agent-pay` 0.5.3 or later.

## 3. Or through MCP (Claude, Cursor, OpenClaw)

Add to the merchants of your [agent-pay-mcp](https://github.com/DeepFirstHQ/deepfirstsearch/tree/main/integrations/mcp) config, then ask the agent to use `https://agent.massive.com/v3/reference/tickers/AAPL`:

```json
{ "origin": "https://agent.massive.com", "label": "Massive", "payTo": "0x525f6dDcE9aF7a7179D7696aaBfCd5FCd15a21e6",
  "price": "0.01", "maxPerTx": "0.02", "maxSpend": "1.00" }
```

Source, issues and the full SDK: [github.com/DeepFirstHQ/deepfirstsearch](https://github.com/DeepFirstHQ/deepfirstsearch). Questions or a merchant you'd like covered: [Discussions](https://github.com/DeepFirstHQ/deepfirstsearch/discussions).

## If Massive changes its price or address

The pins are deliberate. The 402 is written by the server, and a 402 that suddenly names another address or a higher price is exactly what a redirected or hijacked payment looks like. So when Massive reprices or rotates its wallet, Agent Safe refuses and nothing is signed:
- a higher price gives `price_changed` (action `ask_owner`), or `over_cap` if it is also above your per-call cap;
- a different address gives `payee_mismatch` (action `report`).

Confirm the change through Massive's own channels (its site, docs or announcement), then update `pricePin` or `payTo` in the registry, or `price` or `payTo` in the MCP config. To absorb small price changes without a prompt, allow a tolerance instead of removing the pin: `toleranceBps` in the registry (1000 = up to 10% over the pin) or `tolerancePct` in the MCP config.

> Agent Safe is an independent open-source project (MIT), live on Base mainnet as an unaudited beta. Not affiliated with Massive.
