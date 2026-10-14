import { describe, expect, it } from "vitest";
import { getAddress } from "viem";
import { Config } from "../src/config.js";
import { VERIFIED_PRESET } from "../src/presets.js";

const base = { network: "eip155:8453", preset: "verified", periodBudget: { amount: "1.00", hours: 24 } };

describe("verified preset", () => {
  it("every entry is a valid merchant on Base, with a checksummed payee and an example URL on its own origin", () => {
    expect(VERIFIED_PRESET.entries.length).toBeGreaterThanOrEqual(30);
    const origins = new Set<string>();
    for (const e of VERIFIED_PRESET.entries) {
      expect(() => getAddress(e.payTo)).not.toThrow();
      expect(new URL(e.example.url).origin).toBe(new URL(e.origin).origin);
      expect(new URL(e.origin).protocol).toBe("https:");
      origins.add(new URL(e.origin).origin);
    }
    expect(origins.size).toBe(VERIFIED_PRESET.entries.length);
    expect([...origins].some((o) => o.includes("coinmarketcap"))).toBe(false);
  });

  it("loads the preset with the owner's per-merchant cap", () => {
    const c = Config.parse({ ...base, presetMaxSpend: "0.10" });
    expect(c.merchants).toHaveLength(VERIFIED_PRESET.entries.length);
    const ni = c.merchants.find((m) => m.origin === "https://netintel.dev")!;
    expect(ni.payTo).toBe("0xdaDc335482AD545296Fd7b28518A251fFCbEb9Df");
    expect(ni.price).toBe(3000n);
    expect(ni.maxSpend).toBe(100_000n);
  });

  it("never overrides the owner's own entry, and leaves out excluded origins", () => {
    const mine = { origin: "https://netintel.dev", payTo: "0x1111111111111111111111111111111111111111", price: "0.001", maxPerTx: "0.001", maxSpend: "0.01" };
    const c = Config.parse({ ...base, merchants: [mine], presetExclude: ["https://402.pinata.cloud"] });
    const ni = c.merchants.filter((m) => m.origin === "https://netintel.dev");
    expect(ni).toHaveLength(1);
    expect(ni[0]!.payTo).toBe("0x1111111111111111111111111111111111111111");
    expect(c.merchants.some((m) => new URL(m.origin).origin === "https://402.pinata.cloud")).toBe(false);
  });

  it("requires a period budget, Base mainnet, and no vault", () => {
    expect(() => Config.parse({ network: "eip155:8453", preset: "verified" })).toThrow(/periodBudget/);
    expect(() => Config.parse({ ...base, network: "eip155:84532" })).toThrow(/Base mainnet/);
    expect(() => Config.parse({ ...base, vault: "0x2222222222222222222222222222222222222222", tranche: "0.05" })).toThrow(/payers you fund yourself/);
    expect(() => Config.parse({ network: "eip155:8453" })).toThrow(/at least one merchant/);
  });

  it("presetOnly picks just the sellers you use, and names an unknown one", () => {
    const c = Config.parse({ ...base, presetOnly: ["https://netintel.dev", "https://402.pinata.cloud"] });
    expect(c.merchants.map((m) => new URL(m.origin).origin).sort()).toEqual(["https://402.pinata.cloud", "https://netintel.dev"]);
    expect(() => Config.parse({ ...base, presetOnly: ["https://nope.example"] })).toThrow(/nope\.example is not in the verified preset/);
  });
});

