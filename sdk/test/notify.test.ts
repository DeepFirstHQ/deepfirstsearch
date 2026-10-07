import { describe, expect, it } from "vitest";
import { formatAlerts, notify } from "../scripts/notify.js";

const calls: { url: string; body: any }[] = [];
const ok = async (url: string, init: RequestInit) => (calls.push({ url, body: JSON.parse(String(init.body)) }), new Response("{}", { status: 200 }));

describe("monitor notifications (#11)", () => {
  it("sends nothing without alerts or without configuration", async () => {
    calls.length = 0;
    expect(await notify([], "x", { DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/1/a" }, ok)).toEqual([]);
    expect(await notify(["a"], "x", {}, ok)).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("delivers to Telegram and Discord with platform-sized messages and no mentions", async () => {
    calls.length = 0;
    const alerts = Array.from({ length: 200 }, (_, i) => `large Funded ${i} USDC from 0x${"ab".repeat(20)} (tx 0x${"cd".repeat(32)})`);
    const r = await notify(alerts, "blocks 1–2", { TELEGRAM_BOT_TOKEN: "123:abc", TELEGRAM_CHAT_ID: "-100", DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/1/a" }, ok);
    expect(r).toEqual(["telegram: delivered", "discord: delivered"]);
    expect(calls[0]!.url).toBe("https://api.telegram.org/bot123:abc/sendMessage");
    expect(calls[0]!.body.text.length).toBeLessThanOrEqual(4096);
    expect(calls[1]!.body.content.length).toBeLessThanOrEqual(2000);
    expect(calls[1]!.body.allowed_mentions).toEqual({ parse: [] });
  });

  it("reports failures without throwing or echoing the token", async () => {
    const bad = async () => new Response("no", { status: 401 });
    const boom = async () => { throw new TypeError("network"); };
    expect(await notify(["a"], "x", { TELEGRAM_BOT_TOKEN: "secret-token", TELEGRAM_CHAT_ID: "1" }, bad)).toEqual(["telegram: failed (HTTP 401)"]);
    const r = await notify(["a"], "x", { TELEGRAM_BOT_TOKEN: "secret-token", TELEGRAM_CHAT_ID: "1" }, boom);
    expect(r).toEqual(["telegram: failed (TypeError)"]);
    expect(r.join()).not.toContain("secret-token");
  });

  it("refuses a Discord URL that is not a Discord webhook", async () => {
    calls.length = 0;
    expect(await notify(["a"], "x", { DISCORD_WEBHOOK_URL: "https://evil.example/hook" }, ok)).toEqual(["discord: skipped (not a Discord webhook URL)"]);
    expect(calls).toHaveLength(0);
  });

  it("formats a short header and bullets", () => {
    expect(formatAlerts(["x"], "blocks 1–2", 100)).toBe("Agent Safe monitor: 1 alert (blocks 1–2)\n• x");
  });
});
