import {
  AiUnavailable,
  type ChatMessage,
  type ChatModel,
  type Fetch,
  type ModelReply,
  type ModelRequest,
  type ToolCall,
} from "./model.ts";

type OpenAiConfig = { url: string; key: string | undefined; model: string; name: string };

const UNREADABLE = "its reply couldn't be read";

function wireMessage(message: ChatMessage): Record<string, unknown> {
  if (message.role === "user") return { role: "user", content: message.text };
  if (message.role === "tool") {
    return { role: "tool", tool_call_id: message.callId, content: message.text };
  }
  const wire: Record<string, unknown> = { role: "assistant", content: message.text };
  if (message.toolCalls?.length) {
    wire.tool_calls = message.toolCalls.map((call) => ({
      id: call.id,
      type: "function",
      function: {
        name: call.name,
        arguments: call.badArguments ?? JSON.stringify(call.arguments ?? {}),
      },
    }));
  }
  return wire;
}

function readCall(raw: unknown): ToolCall {
  const call = raw as { id?: unknown; function?: { name?: unknown; arguments?: unknown } };
  const { id, function: fn } = call;
  if (typeof id !== "string" || typeof fn?.name !== "string") throw new AiUnavailable(UNREADABLE);
  const text = typeof fn.arguments === "string" ? fn.arguments : "{}";
  try {
    return { id, name: fn.name, arguments: JSON.parse(text) };
  } catch {
    return { id, name: fn.name, arguments: undefined, badArguments: text };
  }
}

function readReply(data: unknown): ModelReply {
  const root = data as {
    choices?: { message?: { content?: unknown; tool_calls?: unknown } }[];
    usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
  } | null;
  const message = root?.choices?.[0]?.message;
  if (!message || typeof message !== "object") throw new AiUnavailable(UNREADABLE);
  const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  const reply: ModelReply = {
    text: typeof message.content === "string" ? message.content : "",
    toolCalls: calls.map(readCall),
  };
  const { prompt_tokens: input, completion_tokens: output } = root?.usage ?? {};
  if (typeof input === "number" && typeof output === "number") reply.usage = { input, output };
  return reply;
}

/**
 * An OpenAI-format Chat Completions connector (OpenAI, Ollama, and others that copy it).
 * Plain `fetch` to the one configured base URL, no redirects, never logs. Failure reasons
 * are fixed wording: they never carry the key, a header or the request or reply body.
 */
export function openAiModel(config: OpenAiConfig, fetchImpl: Fetch = fetch): ChatModel {
  const endpoint = `${config.url.replace(/\/+$/, "")}/chat/completions`;
  return {
    name: config.name,
    async reply(request: ModelRequest): Promise<ModelReply> {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (config.key) headers.authorization = `Bearer ${config.key}`;
      const body: Record<string, unknown> = {
        model: config.model,
        messages: [
          { role: "system", content: request.system },
          ...request.messages.map(wireMessage),
        ],
      };
      if (request.tools.length > 0) {
        body.tools = request.tools.map((tool) => ({
          type: "function",
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema,
          },
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
      if (!response.ok) throw new AiUnavailable(`it answered with status ${response.status}`);
      let data: unknown;
      try {
        data = await response.json();
      } catch {
        throw new AiUnavailable(UNREADABLE);
      }
      return readReply(data);
    },
  };
}
