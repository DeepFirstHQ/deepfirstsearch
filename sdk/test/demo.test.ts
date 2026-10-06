import { describe, expect, it } from "vitest";
import { demo } from "../src/cli/demo.js";
import { startMockServer } from "../src/testing/index.js";

describe("agent-pay demo", () => {
  it("pays three times, refuses four attacks, sends nothing to the attacker", async () => {
    const out: string[] = [];
    expect(await demo({ out: (s) => out.push(s), err: () => {} }, false)).toBe(0);
    const text = out.join("\n");
    expect(text.match(/✓ paid/g)).toHaveLength(3);
    expect(text.match(/✗ refused/g)).toHaveLength(4);
    expect(text).toMatch(/signatures sent to attackers: 0/);
    expect(text).toMatch(/hash chain intact/);
  });

  it("exports the mock merchant for partners' own tests", async () => {
    const m = await startMockServer({ "/x": { price: 1n, payTo: "0x1111111111111111111111111111111111111111" } });
    expect((await fetch(`${m.url}/x`)).status).toBe(402);
    await m.close();
  });
});
