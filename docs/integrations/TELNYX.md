# Telnyx + Agent Safe: LLM inference for agents, inside a budget

Telnyx serves LLM inference to agents over x402, paid per call in USDC on Base, no API key needed. Agent Safe adds the guardrail people need before leaving an agent running: payments go **only to Telnyx's address, never above your per-call cap, never past the budget**, whatever the agent was told.

**Tested live on Base mainnet (2026-10-08):** an agent paid Telnyx 0.002237 USDC for `POST /v1/chat/completions/_t/llama-3.1-8b` and got a Llama 3.1 8B chat completion. [Transaction](https://basescan.org/tx/0x66b4c73ff537dcd64fca7853a5e14a8ecd201c2faaeaba8a2529dd4b39c38960). The same 402 checked against a different payee was refused with zero signatures.

## 1. Add Telnyx as a merchant

```ts
import { createAgentPay, MerchantRegistry } from "@deepfirstsearch/agent-pay";

const registry = new MerchantRegistry([{
  origin: "https://x402.telnyx.com",
  payTo: "0x19a78B27a28eD93C3c914878bde7f2f843AfAEa8", // Telnyx's Base address, as in its 402
  network: "eip155:8453",
  maxPerTx: 4_474n, // never more than 0.004474 USDC per call
  pricePin: 2_237n, // 0.002237 USDC, the published price
  label: "Telnyx",
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
const plan = pay.commitPlan([{ origin: "https://x402.telnyx.com", maxSpend: 100_000n }], 60 * 60_000);

const res = await pay.fetch("https://x402.telnyx.com/v1/chat/completions/_t/llama-3.1-8b", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({"model": "meta-llama/Meta-Llama-3.1-8B-Instruct", "messages": [{"role": "user", "content": "Say hello in one short sentence."}], "max_tokens": 64}),
}, { plan });
console.log(res.status, res.payment?.settlement.transaction);
```

A 402 that asks for a different payee, a higher price or a different network is refused before anything is signed. Requires `@deepfirstsearch/agent-pay` 0.5.3 or later.

## 3. Or through MCP (Claude, Cursor, OpenClaw)

Add to the merchants of your [agent-pay-mcp](https://github.com/DeepFirstHQ/deepfirstsearch/tree/main/integrations/mcp) config, then ask the agent to use `https://x402.telnyx.com/v1/chat/completions/_t/llama-3.1-8b`:

```json
{ "origin": "https://x402.telnyx.com", "label": "Telnyx", "payTo": "0x19a78B27a28eD93C3c914878bde7f2f843AfAEa8",
  "price": "0.002237", "maxPerTx": "0.004474", "maxSpend": "1.00" }
```

> Agent Safe is an independent open-source project (MIT), live on Base mainnet as an unaudited beta. Not affiliated with Telnyx.
