// Re-checks every entry of the verified preset against its seller's live 402, WITHOUT paying (agent-pay dryRun):
// the payee must match and the price must be within the pin. Usage: npx tsx scripts/verify-preset.ts
import { MerchantRegistry, commitPlan, dryRun } from "@deepfirstsearch/agent-pay";
import { parseUnits } from "viem";
import { VERIFIED_PRESET } from "../src/presets.js";

let failed = 0;
for (const e of VERIFIED_PRESET.entries) {
  const merchant = {
    origin: e.origin, payTo: e.payTo, network: VERIFIED_PRESET.network, maxPerTx: parseUnits(e.maxPerTx, 6), pricePin: parseUnits(e.price, 6),
    ...("x402Versions" in e ? { x402Versions: [...e.x402Versions] } : {}), ...("maxTimeoutSeconds" in e ? { maxTimeoutSeconds: e.maxTimeoutSeconds } : {}),
  };
  const registry = new MerchantRegistry([merchant]);
  const plan = commitPlan(registry, [{ origin: e.origin, maxSpend: merchant.maxPerTx }], 60_000);
  const ex = e.example as { url: string; method?: string; body?: string };
  let verdict: string;
  try {
    const res = await fetch(ex.url, { method: ex.method ?? "GET", redirect: "manual", signal: AbortSignal.timeout(20_000), ...(ex.body ? { body: ex.body, headers: { "content-type": "application/json" } } : {}) });
    const v = await dryRun(res, { url: ex.url, policy: { allowedNetworks: [VERIFIED_PRESET.network] }, registry, plan });
    verdict = v.kind === "allow" ? "ok" : v.kind === "deny" ? `REFUSED ${v.codes.join(",")}` : v.kind.toUpperCase();
  } catch (err) {
    verdict = `ERROR ${String((err as Error).message).slice(0, 60)}`;
  }
  if (verdict !== "ok") failed++;
  console.log(`${verdict.padEnd(24)} ${e.label}`);
}
console.log(`${VERIFIED_PRESET.entries.length - failed}/${VERIFIED_PRESET.entries.length} verified`);
process.exit(failed ? 1 : 0);
