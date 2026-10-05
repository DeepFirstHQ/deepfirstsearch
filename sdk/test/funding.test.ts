import { afterEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Address } from "viem";
import { createFundingService, remoteFunder } from "../src/wallet/fundingService.js";
import { burnerPayers } from "../src/wallet/burner.js";
import { MerchantRegistry } from "../src/policy/registry.js";
import { merchant, ORIGIN } from "./fixtures.js";

const seed = new Uint8Array(32).fill(5);
const vault: Address = "0x5555555555555555555555555555555555555555";
let server: Server | undefined;
afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

function setup(limits = { maxPerTopUp: 100_000n, maxPerDay: 250_000n }) {
  const sent: { to: Address; amount: bigint }[] = [];
  const registry = new MerchantRegistry([merchant()]);
  const payerFor = burnerPayers(seed, vault);
  const service = createFundingService({
    registry,
    payerFor,
    chainId: 84532,
    limits,
    withdraw: async (to, amount) => {
      sent.push({ to, amount });
      return `wd-${sent.length}`;
    },
  });
  return { service, sent, expectedPayer: payerFor(merchant(), 84532).address };
}

describe("exchange funding service (privacy level 1)", () => {
  it("sends to the payer it derives itself, never to an address from the request", async () => {
    const { service, sent, expectedPayer } = setup();
    const r = await service.topUp(ORIGIN, 50_000n);
    expect(r.ok).toBe(true);
    expect(sent).toEqual([{ to: expectedPayer, amount: 50_000n }]);
  });

  it("refuses unknown merchants and out-of-limit amounts", async () => {
    const { service, sent } = setup();
    expect(await service.topUp("https://evil.example", 1n)).toEqual({ ok: false, reason: "unknown merchant" });
    expect((await service.topUp(ORIGIN, 100_001n)).ok).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it("enforces a daily cap across top-ups", async () => {
    const { service } = setup();
    expect((await service.topUp(ORIGIN, 100_000n)).ok).toBe(true);
    expect((await service.topUp(ORIGIN, 100_000n)).ok).toBe(true);
    expect(await service.topUp(ORIGIN, 100_000n)).toEqual({ ok: false, reason: "daily funding limit reached" });
  });

  it("over HTTP: needs the token, and the agent can only name a merchant", async () => {
    const { service, sent, expectedPayer } = setup();
    server = await service.listen(0, "s3cret");
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const denied = await fetch(url, { method: "POST", headers: { Authorization: "Bearer wrong" }, body: "{}" });
    expect(denied.status).toBe(401);

    // Even if a hijacked agent adds its own destination, the service ignores it.
    const sneaky = await fetch(url, {
      method: "POST",
      headers: { Authorization: "Bearer s3cret" },
      body: JSON.stringify({ origin: ORIGIN, amount: "1000", to: "0x9999999999999999999999999999999999999999" }),
    });
    expect(sneaky.status).toBe(200);
    expect(sent.at(-1)!.to).toBe(expectedPayer);

    const fund = remoteFunder(url, "s3cret");
    await fund(burnerPayers(seed, vault)(merchant(), 84532), merchant(), 2_000n);
    expect(sent.at(-1)).toEqual({ to: expectedPayer, amount: 2_000n });
  });
});
