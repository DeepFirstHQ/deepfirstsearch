# Pinata + Agent Safe: IPFS pinning for agents, inside a budget

Pinata lets agents pin files to IPFS over x402, paid per upload in USDC on Base. Agent Safe adds the guardrail people need before leaving an agent running: payments go **only to Pinata's address, never above your per-call cap, never past the budget**, whatever the agent was told.

**Tested live on Base mainnet (2026-10-07):** an agent paid Pinata 0.001 USDC for `POST /v1/pin/public?fileSize=100` and got a presigned upload URL for a 100-byte file. [Transaction](https://basescan.org/tx/0x75862810412ac3324bda29455ca0ef6d08c378faf6b0a840dde7664f5ccc9be5). The same 402 checked against a different payee was refused with zero signatures.

## 1. Add Pinata as a merchant

```ts
import { createAgentPay, MerchantRegistry } from "@deepfirstsearch/agent-pay";

const registry = new MerchantRegistry([{
  origin: "https://402.pinata.cloud",
  payTo: "0xc900f41481B4F7C612AF9Ce3B1d16A7A1B6bd96E", // Pinata's Base address, as in its 402
  network: "eip155:8453",
  maxPerTx: 2_000n, // never more than 0.002 USDC per call
  pricePin: 1_000n, // 0.001 USDC, the published price
  label: "Pinata",
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
const plan = pay.commitPlan([{ origin: "https://402.pinata.cloud", maxSpend: 100_000n }], 60 * 60_000);

const res = await pay.fetch("https://402.pinata.cloud/v1/pin/public?fileSize=100", { method: "POST" }, { plan });
console.log(res.status, res.payment?.settlement.transaction);
```

A 402 that asks for a different payee, a higher price or a different network is refused before anything is signed. Requires `@deepfirstsearch/agent-pay` 0.5.3 or later.

## 3. Or through MCP (Claude, Cursor, OpenClaw)

Add to the merchants of your [agent-pay-mcp](https://github.com/DeepFirstHQ/deepfirstsearch/tree/main/integrations/mcp) config, then ask the agent to use `https://402.pinata.cloud/v1/pin/public?fileSize=100`:

```json
{ "origin": "https://402.pinata.cloud", "label": "Pinata", "payTo": "0xc900f41481B4F7C612AF9Ce3B1d16A7A1B6bd96E",
  "price": "0.001", "maxPerTx": "0.002", "maxSpend": "1.00" }
```

Source, issues and the full SDK: [github.com/DeepFirstHQ/deepfirstsearch](https://github.com/DeepFirstHQ/deepfirstsearch). Questions or a merchant you'd like covered: [Discussions](https://github.com/DeepFirstHQ/deepfirstsearch/discussions).

## If Pinata changes its price or address

The pins are deliberate. The 402 is written by the server, and a 402 that suddenly names another address or a higher price is exactly what a redirected or hijacked payment looks like. So when Pinata reprices or rotates its wallet, Agent Safe refuses and nothing is signed:
- a higher price gives `price_changed` (action `ask_owner`), or `over_cap` if it is also above your per-call cap;
- a different address gives `payee_mismatch` (action `report`).

Confirm the change through Pinata's own channels (its site, docs or announcement), then update `pricePin` or `payTo` in the registry, or `price` or `payTo` in the MCP config. To absorb small price changes without a prompt, allow a tolerance instead of removing the pin: `toleranceBps` in the registry (1000 = up to 10% over the pin) or `tolerancePct` in the MCP config.

> Agent Safe is an independent open-source project (MIT), live on Base mainnet as an unaudited beta. Not affiliated with Pinata.
