import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fetchSource, nextStep, runTask } from "../src/workflow.js";
import { scriptedModel } from "../src/scripted-model.js";
import { startLocalWorld } from "../src/world.js";

let world: Awaited<ReturnType<typeof startLocalWorld>>;
beforeEach(async () => { world = await startLocalWorld(); });
afterEach(async () => { await world.close(); });

describe("every outcome comes back as a value", () => {
  it("pays the approved seller and keeps the receipt", async () => {
    const o = await fetchSource(world.urls.paid, world.options);
    expect(o).toMatchObject({ outcome: "paid", amount: "0.01", payTo: "0x1111111111111111111111111111111111111111", next: "use_data" });
    expect(o.outcome === "paid" && o.data).toContain("64210.5");
    expect(world.received().honest).toBe(1);
  });

  it("refuses a hijacked 402 with payee_mismatch, and the attacker receives nothing", async () => {
    const o = await fetchSource(world.urls.hijacked, world.options);
    expect(o).toMatchObject({ outcome: "refused", code: "payee_mismatch", action: "report" });
    expect(world.received().mirror).toBe(0);
    expect(nextStep(o)).toMatch(/report it to the owner/);
  });

  it("enforces the sealed plan: the third paid call is refused with plan_exhausted", async () => {
    expect((await fetchSource(world.urls.paid, world.options)).outcome).toBe("paid");
    expect((await fetchSource(world.urls.paid, world.options)).outcome).toBe("paid");
    const third = await fetchSource(world.urls.paid, world.options);
    expect(third).toMatchObject({ outcome: "refused", code: "plan_exhausted", action: "retry_later" });
    expect(world.received().honest).toBe(2);
  });

  it("asks the owner when the price moved above the pin, and says fix_config for a seller the owner never approved", async () => {
    expect(await fetchSource(world.urls.priceMoved, world.options)).toMatchObject({ outcome: "refused", code: "price_changed", action: "ask_owner" });
    expect(await fetchSource(world.urls.stranger, world.options)).toMatchObject({ outcome: "refused", code: "unknown_merchant", action: "fix_config" });
    expect(world.received()).toEqual({ honest: 0, mirror: 0, stranger: 0 });
  });

  it("uses a free source, skips a 404, and treats a dead host as a transport failure, never as a crash", async () => {
    const free = await fetchSource(world.urls.free, world.options);
    expect(free).toMatchObject({ outcome: "no_challenge", status: 200, next: "use_data" });
    expect(free.outcome === "no_challenge" && free.data).toContain("USD_ARS");
    expect(await fetchSource(world.urls.missing, world.options)).toMatchObject({ outcome: "no_challenge", status: 404, data: null, next: "skip" });
    expect(await fetchSource(world.urls.dead, world.options)).toMatchObject({ outcome: "transport_failure", next: "retry_once_then_give_up" });
  });
});

describe("the agent", () => {
  it("runs the whole task through the AI SDK: the model picks sources, the code decides every payment", async () => {
    const u = world.urls;
    const sources = [u.paid, u.paid, u.paid, u.priceMoved, u.hijacked, u.stranger, u.free, u.missing, u.dead];
    const seen: string[] = [];
    const result = await runTask(scriptedModel(sources), "Collect today's prices.", world.options, (_url, o) => seen.push(o.outcome === "refused" ? o.code : o.outcome));
    expect(seen).toEqual(["paid", "paid", "plan_exhausted", "price_changed", "payee_mismatch", "unknown_merchant", "no_challenge", "no_challenge", "transport_failure"]);
    expect(result.text).toMatch(/report it to the owner \(payee_mismatch\)/);
    expect(world.received()).toEqual({ honest: 2, mirror: 0, stranger: 0 });
    // The SDK's tamper-evident audit log recorded the two payments and the refusals it saw.
    expect(world.options.pay.audit.entries.filter((e) => e.event.type === "payment.settled")).toHaveLength(2);
  });
});
