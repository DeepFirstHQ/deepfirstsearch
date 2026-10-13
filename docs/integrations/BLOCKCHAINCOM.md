# Blockchain.com + Agent Safe: Bitcoin explorer data for agents, capped

Blockchain.com's Explorer API answers agents' Bitcoin address and transaction queries over x402, for USDC on Base. Agent Safe adds the guardrail people need before leaving an agent running: payments go **only to Blockchain.com's address, never above your per-call cap, never past the budget**, whatever the agent was told.

**Tested live on Base mainnet (2026-10-07):** an agent paid Blockchain.com 0.001 USDC for `POST /explorer-gateway-kt/x402/btc/address` and got the address summary for the Bitcoin genesis address. [Transaction](https://basescan.org/tx/0x6169b0e731e0ea7cabe39105d6b6209d07781c306fccb34bccc2ec59d5147e5e). The same 402 checked against a different payee was refused with zero signatures.

## 1. Add Blockchain.com as a merchant

```ts
import { createAgentPay, MerchantRegistry } from "@deepfirstsearch/agent-pay";

const registry = new MerchantRegistry([{
  origin: "https://api.blockchain.info",
  payTo: "0x995ffeF6c39234F0bBc95cf0E84FE1B6e6e2d8e0", // Blockchain.com's Base address, as in its 402
  network: "eip155:8453",
  maxPerTx: 2_000n, // never more than 0.002 USDC per call
  pricePin: 1_000n, // 0.001 USDC, the published price
  label: "Blockchain.com",
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
const plan = pay.commitPlan([{ origin: "https://api.blockchain.info", maxSpend: 100_000n }], 60 * 60_000);

const res = await pay.fetch("https://api.blockchain.info/explorer-gateway-kt/x402/btc/address", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({"address": "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa"}),
}, { plan });
console.log(res.status, res.payment?.settlement.transaction);
```

A 402 that asks for a different payee, a higher price or a different network is refused before anything is signed. Requires `@deepfirstsearch/agent-pay` 0.5.3 or later.

## 3. Or through MCP (Claude, Cursor, OpenClaw)

Add to the merchants of your [agent-pay-mcp](https://github.com/DeepFirstHQ/deepfirstsearch/tree/main/integrations/mcp) config, then ask the agent to use `https://api.blockchain.info/explorer-gateway-kt/x402/btc/address`:

```json
{ "origin": "https://api.blockchain.info", "label": "Blockchain.com", "payTo": "0x995ffeF6c39234F0bBc95cf0E84FE1B6e6e2d8e0",
  "price": "0.001", "maxPerTx": "0.002", "maxSpend": "1.00" }
```

Source, issues and the full SDK: [github.com/DeepFirstHQ/deepfirstsearch](https://github.com/DeepFirstHQ/deepfirstsearch). Questions or a merchant you'd like covered: [Discussions](https://github.com/DeepFirstHQ/deepfirstsearch/discussions).

## If Blockchain.com changes its price or address

The pins are deliberate. The 402 is written by the server, and a 402 that suddenly names another address or a higher price is exactly what a redirected or hijacked payment looks like. So when Blockchain.com reprices or rotates its wallet, Agent Safe refuses and nothing is signed:
- a higher price gives `price_changed` (action `ask_owner`), or `over_cap` if it is also above your per-call cap;
- a different address gives `payee_mismatch` (action `report`).

Confirm the change through Blockchain.com's own channels (its site, docs or announcement), then update `pricePin` or `payTo` in the registry, or `price` or `payTo` in the MCP config. To absorb small price changes without a prompt, allow a tolerance instead of removing the pin: `toleranceBps` in the registry (1000 = up to 10% over the pin) or `tolerancePct` in the MCP config.

> Agent Safe is an independent open-source project (MIT), live on Base mainnet as an unaudited beta. Not affiliated with Blockchain.com.
