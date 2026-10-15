/**
 * Read-only against a live seller: what the agent's first step (`dryRun`) sees, with no key and no payment.
 *   npm run live-readonly
 * URLs suggested in issue #40 by the seller's developer: a free route, and a paid route that answers 402, or 200 while
 * a caller's free trial lasts (the same URL can flip). The seller is not in this registry, so a 402 there is refused
 * with `unknown_merchant`: the owner would have to approve it first.
 */
import { MerchantRegistry, commitPlan } from "@deepfirstsearch/agent-pay";
import { fetchSource, nextStep, type WorkflowOptions } from "./workflow.js";

const registry = new MerchantRegistry([]);
const options: WorkflowOptions = {
  registry,
  policy: { allowedNetworks: ["eip155:8453"] },
  plan: commitPlan(registry, [], 60_000),
  // Never reached: with an empty registry nothing can be allowed, so nothing is ever paid.
  pay: { fetch: () => { throw new Error("read-only"); } } as never,
};

for (const url of ["https://api.automaton-sovereign.workers.dev/pricing", "https://api.automaton-sovereign.workers.dev/v2/oracle/base"]) {
  const o = await fetchSource(url, options);
  const detail = o.outcome === "refused" ? `${o.code}: ${o.reason}` : o.outcome === "no_challenge" ? `HTTP ${o.status}` : "";
  console.log(`${new URL(url).pathname.padEnd(16)} ${o.outcome.padEnd(17)} ${detail}\n${"".padEnd(16)} → ${nextStep(o)}`);
}
