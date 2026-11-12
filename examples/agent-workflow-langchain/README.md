# One complete agent workflow, in LangChain.js / LangGraph

The LangChain.js / LangGraph version of [`examples/agent-workflow`](../agent-workflow): an agent researches a task,
reads free and paid sources, and meets every outcome a seller can produce: it pays an approved seller, refuses a
hijacked one, stops at its budget, asks its owner when a price moves, uses a free source, skips a 404 and survives a
dead host. Every outcome comes back as a value with the next step to take, never as an exception. The model chooses
which sources to read; the code decides every payment.

```bash
git clone https://github.com/DeepFirstHQ/deepfirstsearch && cd deepfirstsearch/examples/agent-workflow-langchain
npm i
npm start          # local: mock sellers, no keys, no chain
npm test           # the same, as assertions
```

It uses the published packages: `@deepfirstsearch/agent-pay` 0.12.0 and `@deepfirstsearch/agent-pay-langchain` 0.4.0,
with `@langchain/core` and `@langchain/langgraph` for the agent.

## What the agent sees (`npm start`)

```
source                 outcome           what the agent does
market data /prices    paid              use the data; keep the receipt (0.01 USDC to 0x1111…1111)
market data /prices    paid              use the data; keep the receipt (0.01 USDC to 0x1111…1111)
market data /prices    refused           try again later (plan_exhausted)
market data /premium   refused           ask the owner before going further (price_changed)
hijacked mirror        refused           stop using this source and report it to the owner (payee_mismatch)
unknown seller         refused           tell the owner the setup is missing something (unknown_merchant)
free FX rates          no_challenge      use the data (nothing was paid)
market data /missing   no_challenge      skip this source (HTTP 404, no terms)
dead source            transport_failure retry once, then give up on this source

Payment authorizations received: { honest: 2, mirror: 0, stranger: 0 }
```

Step by step:
1. **Paid, twice.** The seller is in the owner's registry, its payee and price match the pins, and the sealed plan
   allows 0.02 USDC for it this session. The agent keeps each receipt.
2. **`plan_exhausted` → `retry_later`.** A third call would go over the plan sealed before the agent read anything.
3. **`price_changed` → `ask_owner`.** `/premium` asks 0.05, above the 0.01 the owner pinned. A person decides.
4. **`payee_mismatch` → `report`.** A mirror of the same seller now names an attacker as payee, as a hijacked server
   or DNS record would. Nothing is signed: the mirror receives zero payment authorizations.
5. **`unknown_merchant` → `fix_config`.** A seller the owner never approved. The agent can't add it.
6. **`no_challenge`, 200.** A free source: use the data.
7. **`no_challenge`, 404.** No terms were shown. Skip it; a free route, a free trial or a missing page all look like
   this, and the same URL can ask for payment next time.
8. **`transport_failure`.** The request failed before any answer. Not a payment decision: retry once, then give up.

## How it works

- [`src/workflow.ts`](src/workflow.ts): `fetchSource` and `nextStep` are the same as in the AI SDK example —
  `fetchSource` reads the seller's terms with `dryRun` (no key, nothing signed), pays through `pay.fetch` only when
  the policy allows them, and returns one `Outcome`. The tools (`today`, free; `fetch_source`) are LangChain tools,
  and `runTask` drives them with LangGraph's `createReactAgent`, so the payment decisions stay in code whichever
  chat model is plugged in.
- [`src/world.ts`](src/world.ts): the owner's setup (registry, policy, sealed plan) and the local sellers — the
  same world as the AI SDK example.
- [`src/scripted-model.ts`](src/scripted-model.ts): a scripted `BaseChatModel`, a stand-in for an LLM so this runs
  without an API key. Replace it with any LangChain chat model, for example `new ChatOpenAI({ model: "gpt-5" })`
  from `@langchain/openai`: the tools and every payment decision stay the same.
