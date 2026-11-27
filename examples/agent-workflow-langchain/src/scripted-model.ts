import { BaseChatModel, type BindToolsInput } from "@langchain/core/language_models/chat_models";
import { AIMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import type { ChatGeneration, ChatResult } from "@langchain/core/outputs";

/**
 * A stand-in for an LLM, so the example runs with no API key: it asks for today's date, reads each source in turn with
 * `fetch_source`, then writes a summary from what the tools returned. Swap it for any LangChain chat model
 * (`new ChatOpenAI({ model: "gpt-5" })`, `new ChatAnthropic({ model: "claude-sonnet-5-5" })`…): the tools, and every
 * payment decision, stay the same.
 */
export class ScriptedChatModel extends BaseChatModel {
  private readonly urls: string[];
  private readonly label: (url: string) => string;

  constructor(urls: string[], label: (url: string) => string = (u) => new URL(u).pathname) {
    super({});
    this.urls = urls;
    this.label = label;
  }

  _llmType(): string {
    return "scripted-chat-model";
  }

  // createReactAgent requires a bindTools method. The script is fixed, so the tool
  // specs change nothing: the model returns itself.
  bindTools(_tools: BindToolsInput[]) {
    return this;
  }

  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    // What the tools have answered so far, in order.
    const results = messages.filter((m) => ToolMessage.isInstance(m));
    const sources = results.filter((m) => m.name === "fetch_source");
    let message: AIMessage;
    if (results.length === 0) {
      message = new AIMessage({ content: "", tool_calls: [{ name: "today", args: {}, id: "c0", type: "tool_call" }] });
    } else if (sources.length < this.urls.length) {
      const url = this.urls[sources.length]!;
      message = new AIMessage({ content: "", tool_calls: [{ name: "fetch_source", args: { url }, id: `c${sources.length + 1}`, type: "tool_call" }] });
    } else {
      const lines = sources.map((m, i) => {
        const v = JSON.parse(typeof m.content === "string" ? m.content : JSON.stringify(m.content)) as { outcome: string; next_step: string };
        return `- ${this.label(this.urls[i]!)}: ${v.outcome}. I'll ${v.next_step}.`;
      });
      message = new AIMessage(`Here is what I did with each source:\n${lines.join("\n")}`);
    }
    const generation: ChatGeneration = { message, text: typeof message.content === "string" ? message.content : "" };
    return { generations: [generation] };
  }
}

export function scriptedModel(urls: string[], name?: (url: string) => string) {
  return new ScriptedChatModel(urls, name);
}
