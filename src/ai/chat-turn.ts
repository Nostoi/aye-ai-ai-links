import type { Change } from "../mcp/changes.js";
import {
  AiUnavailable,
  type ChatMessage,
  type ChatModel,
  type ModelReply,
  type ToolCall,
} from "./model.js";
import type { ToolSession } from "./tool-session.js";

/** Model calls (tool steps) one turn may make. */
export const MAX_MODEL_CALLS = 8;
/** One turn's time limit, well inside the tunnel's read timeout. */
export const TURN_MS = 85_000;
/** A model call is aborted when this much is left, so a last tool call still has time. */
export const TOOL_RESERVE_MS = 10_000;
/** No tool call starts with less than this left: a save waits up to 4 s for its page. */
export const TOOL_CALL_MS = 5_000;
export const MAX_TURN_CHARS = 8_000;
export const MAX_TEXT_CHARS = 4_000;
export const MAX_HISTORY = 40;
/** Sent once, in place of the empty reply, when a model ends a turn with no text and no tool calls. */
export const EMPTY_REPLY_NUDGE =
  "Please answer the owner now in a sentence or two, based on what you have done and found.";

export type TextTurn = { role: "user" | "assistant"; text: string };

export type TurnResult =
  | { ok: true; reply: string; changes: Change[]; seen: string[] }
  | { ok: false; reason: string; changes: Change[]; seen: string[] };

/** The most cards one reply shows; a later marker is named in the text instead. */
export const MAX_CARDS = 5;

/** Added to the MCP door's instructions for the AI in the app's own panel. */
export const IN_APP_INSTRUCTIONS = `The owner is talking to you inside the app itself. What they write here is in their own words, so record it as "stated", or as "asked" when it answers a question you asked.

<panel>
Your reply appears in a narrow chat panel beside the owner's links. The panel shows plain text only: it does not render Markdown, so asterisks, dashes and hashes appear exactly as typed. A link is shown as a picture card with its title, so the owner sees the links rather than reads about them.
</panel>

<reply_format>
Write one or two short sentences of plain prose. Then, for each link worth showing, put [[link:ID]] on its own line, using the link's id from a tool result, and on the next line a few words on why it fits; the card already shows the title, so don't repeat it. Show at most ${MAX_CARDS} links, best first. When more links match, say so and offer to narrow them down; give a number only when a tool told you the total. After saving or changing links, say what you did in a sentence; the app lists each change below your reply.
</reply_format>

<example>
The owner asks: what's in here about tiles?
Your reply:
Two of your kitchen remodel links are about tile.
[[link:912]]
Compares cost and how each handles grease.
[[link:913]]
The floor, not the backsplash.
</example>`;

// Each reason finishes "<name> didn't answer: …".
const TOO_LONG = "it took too long";
const STOPPING = "the server is stopping";
const CUT_OFF = "its reply was cut off";
export const SERVER_FAULT = "something went wrong on the server";

/** The posted history and text checked against the caps and order, with long assistant turns shortened; null when refused. */
export function takeTurn(body: {
  history: unknown;
  text: unknown;
}): { history: TextTurn[]; text: string } | null {
  const { history, text } = body;
  if (typeof text !== "string" || text.trim() === "" || text.length > MAX_TEXT_CHARS) return null;
  if (!Array.isArray(history) || history.length > MAX_HISTORY || history.length % 2 !== 0) {
    return null;
  }
  const turns: TextTurn[] = [];
  for (const [i, turn] of history.entries()) {
    const { role: given, text: said } = (turn ?? {}) as { role?: unknown; text?: unknown };
    const role = i % 2 === 0 ? "user" : "assistant";
    if (given !== role) return null;
    // Both APIs refuse an empty message.
    if (typeof said !== "string" || said.trim() === "") return null;
    if (said.length <= MAX_TURN_CHARS) turns.push({ role, text: said });
    else if (role === "assistant") turns.push({ role, text: `${said.slice(0, MAX_TURN_CHARS)}…` });
    else return null;
  }
  return { history: turns, text };
}

/** The ids of the links a tool's structured output names, in order. */
function linkIds(structured: unknown): string[] {
  const root = structured as { link?: { id?: unknown }; links?: unknown } | null;
  const found = [root?.link?.id];
  if (Array.isArray(root?.links)) {
    for (const item of root.links as { id?: unknown; link?: { id?: unknown } }[]) {
      found.push(item?.id ?? item?.link?.id);
    }
  }
  return found.filter((id): id is string => typeof id === "string");
}

/**
 * One turn of the in-app chat: the model and the owner's tools, back and forth, until the model
 * answers in text or a limit is reached. Tool calls run one at a time, and a call that has
 * started is never cut short; the limits are checked between steps. Whatever ends the turn, the
 * result lists every change the session recorded.
 */
export async function runChatTurn(input: {
  model: ChatModel;
  session: ToolSession;
  history: TextTurn[];
  text: string;
  now?: () => number;
  signal?: AbortSignal;
  limits?: { calls: number; ms: number };
}): Promise<TurnResult> {
  const { model, session, signal, now = Date.now } = input;
  const limits = input.limits ?? { calls: MAX_MODEL_CALLS, ms: TURN_MS };
  const deadline = now() + limits.ms;
  const system = `${session.instructions}\n\n${IN_APP_INSTRUCTIONS}`;
  const messages: ChatMessage[] = [...input.history, { role: "user", text: input.text }];
  const seen = new Set<string>();
  const known = session.tools.map((tool) => tool.name);

  const ok = (reply: string): TurnResult => ({
    ok: true,
    reply,
    changes: session.changes(),
    seen: [...seen],
  });
  const fail = (reason: string): TurnResult => ({
    ok: false,
    reason,
    changes: session.changes(),
    seen: [...seen],
  });

  const askModel = async (): Promise<ModelReply> => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    const timer = setTimeout(abort, deadline - TOOL_RESERVE_MS - now());
    signal?.addEventListener("abort", abort);
    try {
      return await model.reply({
        system,
        messages,
        tools: session.tools,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  };

  const runTool = async (call: ToolCall): Promise<ChatMessage> => {
    const answer = (text: string, isError: boolean): ChatMessage => ({
      role: "tool",
      callId: call.id,
      name: call.name,
      text,
      isError,
    });
    if (!known.includes(call.name)) {
      return answer(
        `There is no tool named ${call.name}. The tools are: ${known.join(", ")}.`,
        true,
      );
    }
    if (call.badArguments !== undefined) {
      return answer(
        `${call.name} wasn't called: its arguments were invalid JSON. Send them again as one JSON object.`,
        true,
      );
    }
    const result = await session.call(call.name, call.arguments);
    if (!result.isError) for (const id of linkIds(result.structured)) seen.add(id);
    return answer(result.text, result.isError);
  };

  let nudged = false;
  try {
    for (let step = 0; step < limits.calls; step++) {
      if (signal?.aborted) return fail(STOPPING);
      if (deadline - now() <= TOOL_RESERVE_MS) return fail(TOO_LONG);
      const reply = await askModel();
      // A cut-off tool call could carry partial input, so none of them runs.
      if (reply.truncated) return fail(CUT_OFF);
      if (reply.toolCalls.length === 0) {
        if (reply.text.trim() !== "") return ok(reply.text);
        if (nudged) return ok(`${model.name} gave no answer.`);
        // Both APIs refuse an empty assistant message, so only the nudge follows the history.
        nudged = true;
        messages.push({ role: "user", text: EMPTY_REPLY_NUDGE });
        continue;
      }
      const { text, toolCalls, raw } = reply;
      messages.push({ role: "assistant", text, toolCalls, ...(raw === undefined ? {} : { raw }) });
      for (const call of reply.toolCalls) {
        if (signal?.aborted) return fail(STOPPING);
        if (deadline - now() < TOOL_CALL_MS) return fail(TOO_LONG);
        messages.push(await runTool(call));
      }
    }
    return fail(`it needed more than ${limits.calls} steps`);
  } catch (error) {
    // Stopping aborts the model call, which the connector reports as a time-out.
    if (error instanceof AiUnavailable) return fail(signal?.aborted ? STOPPING : error.reason);
    console.error("[ai-chat] the turn failed:", error);
    return fail(SERVER_FAULT);
  }
}
