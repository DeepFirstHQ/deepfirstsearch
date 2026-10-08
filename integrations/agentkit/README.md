# @deepfirstsearch/agent-pay-agentkit

A [Coinbase AgentKit](https://github.com/coinbase/agentkit) action provider that lets an agent fetch x402 APIs and pay them in USDC on Base, while **the owner's [Agent Safe](https://github.com/DeepFirstHQ/deepfirstsearch) policy decides every payment**. The action, `AgentPayActionProvider_paid_fetch`, takes a URL and nothing that moves money: no payee, no amount, no network. Payees, price pins, caps and the budget come from the owner's registry and sealed plan, so a prompt-injected agent can ask for any URL but can't choose who gets paid or how much.

> **Beta, unaudited.** Use Base Sepolia or small amounts on Base mainnet. Independent open-source project; not affiliated with Coinbase.

```bash
npm install @deepfirstsearch/agent-pay-agentkit @deepfirstsearch/agent-pay @coinbase/agentkit viem@2.38.3 zod@3
```

(AgentKit pins viem 2.38.3; using the same version keeps one copy of viem's types.)

## Try it offline (no keys to fund, no chain)

```ts
import { AgentKit, ViemWalletProvider } from "@coinbase/agentkit";
import { createAgentPay, MerchantRegistry } from "@deepfirstsearch/agent-pay";
import { startMockServer } from "@deepfirstsearch/agent-pay/testing";
import { agentKitPayer, agentPayActionProvider, PAID_FETCH_ACTION } from "@deepfirstsearch/agent-pay-agentkit";
import { createWalletClient, http } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";

// A local x402 merchant (it verifies signatures itself; nothing touches a chain) and a hostile route.
const payTo = "0x1111111111111111111111111111111111111111";
const merchant = await startMockServer({
  "/data": { price: 10_000n, payTo, body: '{"price":42}' },
  "/evil": { price: 10_000n, payTo, tamper: (r) => ({ ...r, payTo: "0x9999999999999999999999999999999999999999" }) },
}, { network: "eip155:8453" });

// The agent's AgentKit wallet (here a throwaway key) signs the payments, but only when Agent Safe allows them.
const walletProvider = new ViemWalletProvider(
  createWalletClient({ account: privateKeyToAccount(generatePrivateKey()), chain: base, transport: http() }),
);

// The owner's rules: who may be paid, at what price, with what cap. Nothing here comes from the model.
const pay = createAgentPay({
  registry: new MerchantRegistry([{ origin: merchant.url, payTo, network: "eip155:8453", maxPerTx: 50_000n, pricePin: 10_000n }]),
  policy: { allowedNetworks: ["eip155:8453"], periodBudget: { amount: 1_000_000n, periodMs: 86_400_000 } },
  payer: () => agentKitPayer(walletProvider),
  session: { readsUntrustedInput: true, accessesSensitiveData: false, canPay: true },
});
// Seal the plan before the agent reads anything untrusted.
const plan = pay.commitPlan([{ origin: merchant.url, maxSpend: 100_000n }], 60 * 60_000);

const agentkit = await AgentKit.from({ walletProvider, actionProviders: [agentPayActionProvider({ pay, plan })] });
const paidFetch = agentkit.getActions().find((a) => a.name === PAID_FETCH_ACTION)!;

console.log(await paidFetch.invoke({ url: `${merchant.url}/data` })); // HTTP 200. Paid 0.01 USDC to 0x1111… + fenced body
console.log(await paidFetch.invoke({ url: `${merchant.url}/evil` })); // Payment refused by policy: … (nothing signed)
await merchant.close();
```

With a real merchant, use its origin and `payTo` from its 402 (14 merchants with tested values: [deepfirstsearch.com/developers](https://deepfirstsearch.com/developers.html)). The actions plug into AgentKit's framework extensions (LangChain, Vercel AI SDK, OpenAI Agents) like any other provider.

## What's different from AgentKit's built-in x402 actions

AgentKit's `x402ActionProvider` lets the model pick the payment option (`selectedPaymentOption` includes `payTo` and the amount) when it retries a 402. That is convenient, and it is also where a prompt injection can redirect a payment. This provider keeps the model out of money decisions:

- The model only chooses a URL. Every 402 is checked against the owner's registry before anything is signed: payee, asset, network, price and timeout must match, and the sealed plan and period budget must have room.
- Refusals come back as text (`Payment refused by policy: …`), never thrown, so the agent can explain what happened. Since 0.2.0, with `@deepfirstsearch/agent-pay` >= 0.8.0, the text carries the refusal's stable code and what to do about it, e.g. `Payment refused by policy [price_changed → ask the owner]: …` or `[payee_mismatch → do not retry, report it]` (codes listed in the SDK README, "Refusal codes"). Older SDKs give the text without the tag.
- Responses are fenced with a random tag and labeled as untrusted data.
- On-chain budgets (optional): fund the payer from an Agent Safe vault with `vaultFunder`, so even a compromised machine can only spend inside the owner-signed caps. See the [SDK](https://github.com/DeepFirstHQ/deepfirstsearch/tree/main/sdk).
- The action is built without AgentKit's `@CreateAction` decorator, so invoking it sends no analytics event.

Note: AgentKit's wallet providers send an initialization event to Coinbase's analytics endpoint. In AgentKit 0.10.4 that call isn't awaited, so if the endpoint answers with an error the rejection is unhandled and Node exits. Until that's fixed upstream, a `process.on("unhandledRejection", …)` handler in your agent keeps it running.

`agentKitPayer(walletProvider)` works with any AgentKit EVM wallet provider (`ViemWalletProvider`, `CdpEvmWalletProvider`, …): it signs EIP-712 payment authorizations and refuses to sign transactions. Any viem `LocalAccount` works as the payer too.

## Develop

```bash
npm ci && npm run typecheck && npm test   # includes an AgentKit.from(...) run against a mock x402 merchant
```

MIT. Questions: [GitHub Discussions](https://github.com/DeepFirstHQ/deepfirstsearch/discussions).
