import { MockLanguageModelV4 } from "ai/test";

/**
 * A stand-in for an LLM, so the example runs with no API key: it asks for today's date, reads each source in turn with
 * `fetch_source`, then writes a summary from what the tools returned. Swap it for any AI SDK model
 * (`openai("gpt-5")`, `anthropic("claude-sonnet-5-5")`…): the tools, and every payment decision, stay the same.
 */
export function scriptedModel(urls: string[], name: (url: string) => string = (u) => new URL(u).pathname) {
  const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
  const done = (text: string) => ({ content: [{ type: "text" as const, text }], finishReason: { unified: "stop" as const, raw: "stop" }, usage, warnings: [] });
  const call = (toolName: string, input: unknown, id: string) => ({
    content: [{ type: "tool-call" as const, toolCallId: id, toolName, input: JSON.stringify(input) }],
    finishReason: { unified: "tool-calls" as const, raw: "tool_calls" },
    usage,
    warnings: [],
  });

  return new MockLanguageModelV4({
    doGenerate: async ({ prompt }) => {
      // What the tools have answered so far, in order.
      const results = prompt
        .filter((m) => m.role === "tool")
        .flatMap((m) => m.content)
        .filter((p): p is Extract<typeof p, { type: "tool-result" }> => p.type === "tool-result");
      const sources = results.filter((r) => r.toolName === "fetch_source");
      if (results.length === 0) return call("today", {}, "c0") as never;
      if (sources.length < urls.length) return call("fetch_source", { url: urls[sources.length] }, `c${sources.length + 1}`) as never;
      const lines = sources.map((r, i) => {
        const v = (r.output as { type: string; value: { outcome: string; next_step: string } }).value;
        return `- ${name(urls[i]!)}: ${v.outcome}. I'll ${v.next_step}.`;
      });
      return done(`Here is what I did with each source:\n${lines.join("\n")}`) as never;
    },
  });
}
