/**
 * Local run: the agent works through a research task against local sellers, with no keys and no chain.
 *   npm start
 */
import { runTask } from "./workflow.js";
import { scriptedModel } from "./scripted-model.js";
import { startLocalWorld } from "./world.js";

const world = await startLocalWorld();
const { urls } = world;
// The order the agent reads its sources in. The third call to the paid source goes over the sealed plan.
const sources = [urls.paid, urls.paid, urls.paid, urls.priceMoved, urls.hijacked, urls.stranger, urls.free, urls.missing, urls.dead];
const names = new Map<string, string>([
  [urls.paid, "market data /prices"], [urls.priceMoved, "market data /premium"], [urls.hijacked, "hijacked mirror"],
  [urls.stranger, "unknown seller"], [urls.free, "free FX rates"], [urls.missing, "market data /missing"], [urls.dead, "dead source"],
]);
const name = (url: string) => names.get(url) ?? url;

console.log("Task: collect today's crypto prices and the USD/ARS rate.\n");
console.log(`${"source".padEnd(22)} ${"outcome".padEnd(17)} what the agent does`);
const result = await runTask(scriptedModel(sources, name), "Collect today's crypto prices and the USD/ARS rate.", world.options, (url, o, next) =>
  console.log(`${name(url).padEnd(22)} ${o.outcome.padEnd(17)} ${next}`),
);
console.log(`\n${result.text}\n`);
console.log("Payment authorizations received:", world.received(), "(the hijacked mirror and the stranger got none)");
console.log(`Audit log: ${world.options.pay.audit.entries.length} entries`);
await world.close();
