# @deepfirstsearch/agent-pay-langchain

A LangChain.js tool, ready for LangGraph (`ToolNode`, `createReactAgent`), that lets an agent fetch x402 APIs and pay them in USDC on Base while **an owner-signed, on-chain budget decides every payment**. A prompt-injected agent can ask for any URL; it can't pick the payee, the price or the limit.

> **Beta, unaudited.** Use Base Sepolia or small amounts on Base mainnet.

```bash
npm install @deepfirstsearch/agent-pay-langchain @deepfirstsearch/agent-pay @langchain/core @langchain/langgraph
```

```ts
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { createAgentPay, MerchantRegistry, burnerPayers, vaultFunder } from "@deepfirstsearch/agent-pay";
import { createPaidFetchTool } from "@deepfirstsearch/agent-pay-langchain";

const pay = createAgentPay({
  registry: new MerchantRegistry([
    { origin: "https://api.example.com", payTo: "0x…", network: "eip155:8453", maxPerTx: 50_000n, pricePin: 10_000n },
  ]),
  policy: { allowedNetworks: ["eip155:8453"] },
  payer: burnerPayers(burnerSeed, vault),
  session: { readsUntrustedInput: true, accessesSensitiveData: false, canPay: true },
  ensureFunded: vaultFunder({ agent: agentWallet, publicClient, vault, usdc, intents: { "0x…": intentId }, tranche: 50_000n }),
});

// Seal the plan when the graph starts, before the agent reads anything untrusted.
const plan = pay.commitPlan([{ origin: "https://api.example.com", maxSpend: 200_000n }], 60 * 60_000);

const graph = createReactAgent({ llm, tools: [createPaidFetchTool({ pay, plan })] });
await graph.invoke({ messages: [{ role: "user", content: "Get today's price index from api.example.com" }] });
```

- The tool's schema is only `url`, `method`, `body`, `contentType`. Merchants, price pins, caps and the plan live in `pay` and `plan`, which the model can't reach.
- It returns a JSON string: `{ ok: true, status, paid, body }` with the body fenced as untrusted data, or `{ ok: false, refused: true, reason }`. Since 0.3.0, with `@deepfirstsearch/agent-pay` >= 0.8.0, a policy refusal also carries `code` (stable, e.g. `price_changed`, `payee_mismatch`, `plan_exhausted`) and `action` (`report`, `ask_owner`, `fix_config` or `retry_later`); see "Refusal codes" in the SDK README. With older SDKs both are absent.
- **Try it offline first:** use `payer: () => privateKeyToAccount(generatePrivateKey())`, drop `ensureFunded`, and point the registry at `startMockServer` from `@deepfirstsearch/agent-pay/testing` (see [Test without a chain](https://deepfirstsearch.com/developers.html#test-without-a-chain)).
- Create the vault and budgets with the [owner CLI](https://github.com/DeepFirstHQ/deepfirstsearch/tree/main/sdk#owner-cli-vault-and-budgets-in-three-commands).

## Develop

```bash
npm ci && npm run typecheck && npm test   # includes a LangGraph ToolNode run against a mock x402 merchant
```
