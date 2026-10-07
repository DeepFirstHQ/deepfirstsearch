/**
 * Optional alert delivery for the monitor (issue #11): Telegram and/or Discord, configured only through env.
 *
 *   TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID   → sendMessage to that chat
 *   DISCORD_WEBHOOK_URL                     → post to that channel webhook
 *
 * Delivery never replaces the exit code: a webhook that fails is reported, and the run still fails on alerts.
 */
export type NotifyEnv = Partial<Record<"TELEGRAM_BOT_TOKEN" | "TELEGRAM_CHAT_ID" | "DISCORD_WEBHOOK_URL", string>>;
type Fetch = (url: string, init: RequestInit) => Promise<Response>;

const TELEGRAM_MAX = 4096;
const DISCORD_MAX = 2000;

export function formatAlerts(alerts: string[], context: string, max: number): string {
  const head = `Agent Safe monitor: ${alerts.length} alert${alerts.length === 1 ? "" : "s"} (${context})`;
  const text = [head, ...alerts.map((a) => `• ${a}`)].join("\n");
  return text.length <= max ? text : `${text.slice(0, max - 2)}…`;
}

/** Sends the alerts to every configured channel. Returns one line per channel; never throws, never echoes secrets. */
export async function notify(alerts: string[], context: string, env: NotifyEnv, fetchFn: Fetch = fetch): Promise<string[]> {
  if (!alerts.length) return [];
  const results: string[] = [];
  const send = async (name: string, url: string, body: unknown) => {
    try {
      const r = await fetchFn(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
      results.push(r.ok ? `${name}: delivered` : `${name}: failed (HTTP ${r.status})`);
    } catch (e) {
      results.push(`${name}: failed (${(e as Error).name})`);
    }
  };
  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
    await send("telegram", `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      chat_id: env.TELEGRAM_CHAT_ID,
      text: formatAlerts(alerts, context, TELEGRAM_MAX),
      disable_web_page_preview: true,
    });
  }
  if (env.DISCORD_WEBHOOK_URL) {
    if (!/^https:\/\/(discord\.com|discordapp\.com)\/api\/webhooks\//.test(env.DISCORD_WEBHOOK_URL)) results.push("discord: skipped (not a Discord webhook URL)");
    else await send("discord", env.DISCORD_WEBHOOK_URL, { content: formatAlerts(alerts, context, DISCORD_MAX), allowed_mentions: { parse: [] } });
  }
  return results;
}
