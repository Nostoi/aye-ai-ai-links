import {
  AiUnavailable,
  type ChatMessage,
  type ChatModel,
  type Fetch,
  type ModelReply,
  type ModelRequest,
  type ToolCall,
} from "./model.ts";

type AnthropicConfig = { url: string; key: string | undefined; model: string; name: string };

const UNREADABLE = "its reply couldn't be read";
// The Messages API requires `max_tokens` on every request.
const MAX_TOKENS = 4096;
const API_VERSION = "2023-06-01";

type WireMessage = { role: "user" | "assistant"; content: string | Record<string, unknown>[] };

function wireMessages(messages: ChatMessage[]): WireMessage[] {
  const wire: WireMessage[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      wire.push({ role: "user", content: message.text });
    } else if (message.role === "tool") {
      // Consecutive results answer one assistant turn, so they share one user message.
      const result: Record<string, unknown> = {
        type: "tool_result",
        tool_use_id: message.callId,
        content: message.text,
      };
      if (message.isError) result.is_error = true;
      const last = wire[wire.length - 1];
      const open =
        last?.role === "user" &&
        Array.isArray(last.content) &&
        last.content.every((block) => block.type === "tool_result");
      if (open && Array.isArray(last.content)) last.content.push(result);
      else wire.push({ role: "user", content: [result] });
    } else {
      const blocks: Record<string, unknown>[] = [];
      if (message.text) blocks.push({ type: "text", text: message.text });
      for (const call of message.toolCalls ?? []) {
        blocks.push({
          type: "tool_use",
          id: call.id,
          name: call.name,
          input: call.arguments ?? {},
        });
      }
      wire.push({ role: "assistant", content: blocks });
    }
  }
  return wire;
}

function readReply(data: unknown): ModelReply {
  const root = data as {
    content?: unknown;
    usage?: { input_tokens?: unknown; output_tokens?: unknown };
  } | null;
  if (!Array.isArray(root?.content)) throw new AiUnavailable(UNREADABLE);
  let text = "";
  const toolCalls: ToolCall[] = [];
  for (const block of root.content as { type?: unknown; [key: string]: unknown }[]) {
    if (block?.type === "text" && typeof block.text === "string") {
      text += block.text;
    } else if (block?.type === "tool_use") {
      if (typeof block.id !== "string" || typeof block.name !== "string") {
        throw new AiUnavailable(UNREADABLE);
      }
      toolCalls.push({ id: block.id, name: block.name, arguments: block.input ?? {} });
    }
  }
  const reply: ModelReply = { text, toolCalls };
  const { input_tokens: input, output_tokens: output } = root.usage ?? {};
  if (typeof input === "number" && typeof output === "number") reply.usage = { input, output };
  return reply;
}

/**
 * An Anthropic Messages API connector. Plain `fetch` to the one configured base URL, no
 * redirects, never logs. Failure reasons are fixed wording: they never carry the key, a
 * header or the request or reply body.
 */
export function anthropicModel(config: AnthropicConfig, fetchImpl: Fetch = fetch): ChatModel {
  const endpoint = `${config.url.replace(/\/+$/, "")}/v1/messages`;
  return {
    name: config.name,
    async reply(request: ModelRequest): Promise<ModelReply> {
      const headers: Record<string, string> = {
        "content-type": "application/json",
        "anthropic-version": API_VERSION,
      };
      if (config.key) headers["x-api-key"] = config.key;
      const body: Record<string, unknown> = {
        model: config.model,
        max_tokens: MAX_TOKENS,
        system: request.system,
        messages: wireMessages(request.messages),
      };
      if (request.tools.length > 0) {
        body.tools = request.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          input_schema: tool.inputSchema,
        }));
      }
      let response: Response;
      try {
        response = await fetchImpl(endpoint, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: request.signal,
          redirect: "error",
        });
      } catch {
        throw new AiUnavailable(request.signal.aborted ? "it timed out" : "it couldn't be reached");
      }
      if (response.status === 401 || response.status === 403) {
        throw new AiUnavailable("it refused the key");
      }
      if (response.status === 529) throw new AiUnavailable("it is busy right now");
      if (!response.ok) throw new AiUnavailable(`it answered with status ${response.status}`);
      let data: unknown;
      try {
        data = await response.json();
      } catch {
        throw new AiUnavailable(request.signal.aborted ? "it timed out" : UNREADABLE);
      }
      return readReply(data);
    },
  };
}
