# Brazilayer + Agent Safe: Brazilian company checks for agents, inside a budget

Brazilayer answers whether a Brazilian company (CNPJ) exists in the Receita Federal registry and is active, for agents over x402, paid per call in USDC on Base. Agent Safe adds the guardrail people need before leaving an agent running: payments go **only to Brazilayer's address, never above your per-call cap, never past the budget**, whatever the agent was told.

**Tested live on Base mainnet (2026-10-13):** an agent paid Brazilayer 0.001 USDC for `GET /v1/cnpj/situacao/33000167000101` and got the Receita Federal registration status for a public CNPJ. [Transaction](https://basescan.org/tx/0x8158a6ef6545a52487f53957a54323716755a3abd65406b25d693a1a693fa7b5). The same 402 checked against a different payee was refused with zero signatures.

## 1. Add Brazilayer as a merchant

```ts
import { createAgentPay, MerchantRegistry } from "@deepfirstsearch/agent-pay";

const registry = new MerchantRegistry([{
  origin: "https://api.brazilayer.com",
  payTo: "0x3Cc1D8ee1dfdFd326c19B0884B8dF4b24B623f0c", // Brazilayer's Base address, as in its 402
  network: "eip155:8453",
  maxPerTx: 2_000n, // never more than 0.002 USDC per call
  pricePin: 1_000n, // 0.001 USDC, the published price
  label: "Brazilayer",
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
const plan = pay.commitPlan([{ origin: "https://api.brazilayer.com", maxSpend: 100_000n }], 60 * 60_000);

const res = await pay.fetch("https://api.brazilayer.com/v1/cnpj/situacao/33000167000101", { method: "GET" }, { plan });
console.log(res.status, res.payment?.settlement.transaction);
```

A 402 that asks for a different payee, a higher price or a different network is refused before anything is signed. Requires `@deepfirstsearch/agent-pay` 0.5.3 or later.

## 3. Or through MCP (Claude, Cursor, OpenClaw)

Add to the merchants of your [agent-pay-mcp](https://github.com/DeepFirstHQ/deepfirstsearch/tree/main/integrations/mcp) config, then ask the agent to use `https://api.brazilayer.com/v1/cnpj/situacao/33000167000101`:

```json
{ "origin": "https://api.brazilayer.com", "label": "Brazilayer", "payTo": "0x3Cc1D8ee1dfdFd326c19B0884B8dF4b24B623f0c",
  "price": "0.001", "maxPerTx": "0.002", "maxSpend": "1.00" }
```

## If Brazilayer changes its price or address

The pins are deliberate. The 402 is written by the server, and a 402 that suddenly names another address or a higher price is exactly what a redirected or hijacked payment looks like. So when Brazilayer reprices or rotates its wallet, Agent Safe refuses and nothing is signed:
- a higher price gives `price_changed` (action `ask_owner`), or `over_cap` if it is also above your per-call cap;
- a different address gives `payee_mismatch` (action `report`).

Confirm the change through Brazilayer's own channels (its site, docs or announcement), then update `pricePin` or `payTo` in the registry, or `price` or `payTo` in the MCP config. To absorb small price changes without a prompt, allow a tolerance instead of removing the pin: `toleranceBps` in the registry (1000 = up to 10% over the pin) or `tolerancePct` in the MCP config.

> Agent Safe is an independent open-source project (MIT), live on Base mainnet as an unaudited beta. Not affiliated with Brazilayer.
