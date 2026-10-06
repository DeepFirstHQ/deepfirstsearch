import { afterEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Address } from "viem";
import { burnerPayers, deriveBurnerKey } from "../../src/wallet/burner.js";
import { vaultFunder } from "../../src/wallet/vault.js";
import { createFundingService } from "../../src/wallet/fundingService.js";
import { MerchantRegistry } from "../../src/policy/registry.js";
import { checkStealthAddress, decodeMetaAddress, generateStealthAddress } from "../../src/wallet/stealth.js";
import { merchant, ORIGIN, payer } from "../fixtures.js";

const seed = new Uint8Array(32).fill(7);
const vault: Address = "0x5555555555555555555555555555555555555555";
const A: Address = "0x1111111111111111111111111111111111111111";
const B: Address = "0x2222222222222222222222222222222222222222";

describe("regression: burner derivation domain separation", () => {
  it("differs per merchant, chain, epoch and vault, and is deterministic", () => {
    const base = { ownerSeed: seed, vault, chainId: 84532, counterparty: A };
    const keys = new Set([
      deriveBurnerKey(base),
      deriveBurnerKey({ ...base, counterparty: B }),
      deriveBurnerKey({ ...base, chainId: 8453 }),
      deriveBurnerKey({ ...base, epoch: 1 }),
      deriveBurnerKey({ ...base, vault: B }),
      deriveBurnerKey({ ...base, ownerSeed: new Uint8Array(32).fill(8) }),
    ]);
    expect(keys.size).toBe(6);
    expect(deriveBurnerKey(base)).toBe(deriveBurnerKey({ ...base, counterparty: A.toLowerCase() as Address }));
  });
  it("info fields cannot be shifted into each other (numbers and checksummed addresses contain no '|')", () => {
    // chainId 1, epoch 23 vs chainId 12, epoch 3 must differ
    const k1 = deriveBurnerKey({ ownerSeed: seed, vault, chainId: 1, counterparty: A, epoch: 23 });
    const k2 = deriveBurnerKey({ ownerSeed: seed, vault, chainId: 12, counterparty: A, epoch: 3 });
    expect(k1).not.toBe(k2);
  });
});

describe("SDK-I-4 burner is per payTo, not per merchant origin", () => {
  it("two merchants that share a payTo (e.g. one facilitator/processor address) get the same payer", () => {
    const payers = burnerPayers(seed, vault);
    const m1 = merchant({ origin: "https://a.example", payTo: A });
    const m2 = merchant({ origin: "https://b.example", payTo: A });
    expect(payers(m1, 84532).address).toBe(payers(m2, 84532).address);
  });
});

function mockClients(balance: { v: bigint }) {
  const writes: { args: readonly unknown[] }[] = [];
  return {
    writes,
    opts: {
      agent: {
        account: { address: "0x00000000000000000000000000000000000000aa" },
        chain: undefined,
        writeContract: async (c: { args: readonly unknown[] }) => {
          writes.push({ args: c.args });
          balance.v += c.args[2] as bigint;
          return "0xhash";
        },
      } as never,
      publicClient: {
        readContract: async () => balance.v,
        waitForTransactionReceipt: async () => new Promise((r) => setTimeout(() => r({ status: "success" }), 10)),
      } as never,
      vault,
      usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as Address,
      intents: { [A]: "0x" + "11".repeat(32) } as Record<Address, `0x${string}`>,
      confirmations: 0,
    },
  };
}

describe("vaultFunder", () => {
  it("regression: refuses a merchant with no owner-signed intent and funds only the given payer", async () => {
    const bal = { v: 0n };
    const { opts, writes } = mockClients(bal);
    const fund = vaultFunder({ ...opts, tranche: 100_000n });
    await expect(fund(payer, merchant({ payTo: B }), 10_000n)).rejects.toThrow(/no owner-signed intent/);
    await fund(payer, merchant({ payTo: A }), 10_000n);
    expect(writes[0]!.args).toEqual(["0x" + "11".repeat(32), payer.address, 100_000n]);
  });

  it("SDK-I-6 never sends a negative top-up when the burner holds more than `tranche` but less than `amount`", async () => {
    const bal = { v: 60_000n }; // leftover from an older, larger tranche, or a donation
    const { opts, writes } = mockClients(bal);
    const fund = vaultFunder({ ...opts, tranche: 50_000n });
    await fund(payer, merchant({ payTo: A }), 100_000n).catch(() => undefined);
    for (const w of writes) expect(w.args[2] as bigint).toBeGreaterThan(0n);
    // and the payment is still covered: it tops up to the amount itself
    expect(writes).toHaveLength(1);
    expect(writes[0]!.args[2]).toBe(40_000n);
  });

  it("regression (prefund change): background top-up targets the same signed payer and only up to `tranche`", async () => {
    const bal = { v: 15_000n };
    const { opts, writes } = mockClients(bal);
    const fund = vaultFunder({ ...opts, tranche: 100_000n });
    await fund(payer, merchant({ payTo: A }), 10_000n); // covers this one, not the next -> prefund
    await fund(payer, merchant({ payTo: A }), 10_000n); // awaits the in-flight prefund first
    expect(writes.length).toBeGreaterThanOrEqual(1);
    for (const w of writes) expect(w.args[1]).toBe(payer.address);
    expect(writes[0]!.args[2]).toBe(85_000n);
  });

  it("concurrent calls for one payer are serialized: a single fundBurner, no OverTranche revert", async () => {
    const bal = { v: 0n };
    const { opts, writes } = mockClients(bal);
    const fund = vaultFunder({ ...opts, tranche: 100_000n });
    await Promise.all([fund(payer, merchant({ payTo: A }), 10_000n), fund(payer, merchant({ payTo: A }), 10_000n)]);
    expect(writes).toHaveLength(1);
    expect(writes[0]!.args[2]).toBe(100_000n);
  });
});

describe("regression: funding service", () => {
  let server: Server | undefined;
  afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

  function svc() {
    const sent: { to: Address; amount: bigint }[] = [];
    const service = createFundingService({
      registry: new MerchantRegistry([merchant()]),
      payerFor: burnerPayers(seed, vault),
      chainId: 84532,
      limits: { maxPerTopUp: 100_000n, maxPerDay: 150_000n },
      withdraw: async (to, amount) => (sent.push({ to, amount }), "ref"),
    });
    return { service, sent };
  }

  it("concurrent top-ups cannot exceed the daily limit (history is reserved before the await)", async () => {
    const { service, sent } = svc();
    const rs = await Promise.all(Array.from({ length: 5 }, () => service.topUp(ORIGIN, 100_000n)));
    expect(rs.filter((r) => r.ok)).toHaveLength(1);
    expect(sent).toHaveLength(1);
  });

  it("ignores extra body fields like `to`, rejects negative / scientific amounts and non-registry origins", async () => {
    const { service, sent } = svc();
    server = await service.listen(0, "tok");
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const post = (body: unknown) =>
      fetch(url, { method: "POST", headers: { Authorization: "Bearer tok" }, body: JSON.stringify(body) });
    expect((await post({ origin: ORIGIN, amount: "-1" })).status).toBe(403);
    expect((await post({ origin: ORIGIN, amount: "1e5" })).status).toBe(400);
    expect((await post({ origin: "http://evil.example", amount: "1" })).status).toBe(403);
    expect((await post({ origin: ORIGIN, amount: "1000", to: B })).status).toBe(200);
    expect(sent[0]!.to).not.toBe(B);
    expect((await fetch(url, { method: "GET", headers: { Authorization: "Bearer tok" } })).status).toBe(401);
  });
});

describe("regression: stealth helpers reject malformed input", () => {
  it("rejects bad meta-addresses and off-curve keys; round-trips valid ones", async () => {
    const { secp256k1 } = await import("@noble/curves/secp256k1.js");
    expect(() => decodeMetaAddress("st:eth:0x1234")).toThrow();
    const bad = `st:eth:0x02${"00".repeat(32)}02${"00".repeat(32)}`;
    expect(() => generateStealthAddress(bad)).toThrow();
    const spend = secp256k1.utils.randomSecretKey();
    const view = secp256k1.utils.randomSecretKey();
    const meta = `st:eth:0x${Buffer.from(secp256k1.getPublicKey(spend, true)).toString("hex")}${Buffer.from(secp256k1.getPublicKey(view, true)).toString("hex")}`;
    const s = generateStealthAddress(meta);
    expect(checkStealthAddress({ ...s, ephemeralPublicKey: s.ephemeralPublicKey, viewingPrivateKey: view, spendingPublicKey: secp256k1.getPublicKey(spend, true) })).toBe(true);
  });
});
