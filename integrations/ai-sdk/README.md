# @deepfirstsearch/agent-pay-ai-sdk

A [Vercel AI SDK](https://ai-sdk.dev) tool that lets a model fetch x402 APIs and pay them in USDC on Base, while **an owner-signed, on-chain budget decides every payment**. A prompt-injected model can ask for any URL; it can't pick the payee, the price or the limit.

> **Beta, unaudited.** Use Base Sepolia or small amounts on Base mainnet.

```bash
npm install @deepfirstsearch/agent-pay-ai-sdk @deepfirstsearch/agent-pay ai zod
```

```ts
import { generateText, isStepCount } from "ai";
import { createAgentPay, MerchantRegistry, burnerPayers, vaultFunder } from "@deepfirstsearch/agent-pay";
import { paidFetchTool } from "@deepfirstsearch/agent-pay-ai-sdk";

const pay = createAgentPay({
  registry: new MerchantRegistry([
    { origin: "https://api.example.com", payTo: "0x…", network: "eip155:8453", maxPerTx: 50_000n, pricePin: 10_000n },
  ]),
  policy: { allowedNetworks: ["eip155:8453"], periodBudget: { amount: 1_000_000n, periodMs: 86_400_000 } },
  payer: burnerPayers(burnerSeed, vault),
  session: { readsUntrustedInput: true, accessesSensitiveData: false, canPay: true },
  ensureFunded: vaultFunder({ agent, publicClient, vault, usdc, intents: { "0x…": intentId }, tranche: 50_000n }),
});

// Seal the plan before the model reads anything untrusted.
const plan = pay.commitPlan([{ origin: "https://api.example.com", maxSpend: 200_000n }], 60 * 60_000);

const { text } = await generateText({
  model,
  tools: { paid_fetch: paidFetchTool({ pay, plan }) },
  prompt: "Get today's price index from api.example.com and summarize it.",
  stopWhen: isStepCount(5),
});
```

- The tool's input is only `url`, `method`, `body` and `contentType`. Merchants, price pins, caps and the plan live in `pay` and `plan`.
- A paid response comes back as `{ ok: true, status, paid: { amount, payTo, transaction }, body }`, with the body fenced as untrusted data. A refusal comes back as `{ ok: false, refused: true, reason }`, so the model can tell the user why.
- Create the vault and the per-merchant budgets with the [owner CLI](https://github.com/DeepFirstHQ/deepfirstsearch/tree/main/sdk#owner-cli-vault-and-budgets-in-three-commands).

## Develop

```bash
npm ci && npm run typecheck && npm test   # includes a generateText run with a mock model against a mock x402 merchant
```
