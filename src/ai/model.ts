/** A tool the AI may call, in the shape the MCP door lists it. */
export type ToolSpec = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

/** `badArguments` holds the raw string when a connector couldn't parse a call's arguments. */
export type ToolCall = { id: string; name: string; arguments: unknown; badArguments?: string };

/**
 * An assistant message's `raw` is its reply's `raw`, kept so the connector that set it can send it
 * back unchanged later in the same turn. It never leaves the turn.
 */
export type ChatMessage =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string; toolCalls?: ToolCall[]; raw?: unknown }
  | { role: "tool"; callId: string; name: string; text: string; isError: boolean };

/**
 * `truncated` is set when the reply hit the token limit, so its text or tool calls may be cut off.
 * `raw` is the reply's content as the provider sent it, for a connector that must send it back
 * exactly (Claude's thinking blocks); only that connector reads it.
 */
export type ModelReply = {
  text: string;
  toolCalls: ToolCall[];
  usage?: { input: number; output: number };
  truncated?: boolean;
  raw?: unknown;
};

export type ModelRequest = {
  system: string;
  messages: ChatMessage[];
  tools: ToolSpec[];
  signal: AbortSignal;
};

/** One AI connection, whatever wire format it speaks. */
export interface ChatModel {
  readonly name: string;
  reply(request: ModelRequest): Promise<ModelReply>;
}

/** The AI couldn't be used; `reason` finishes "<name> didn't answer: …". */
export class AiUnavailable extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "AiUnavailable";
  }
}

export type Fetch = typeof fetch;
