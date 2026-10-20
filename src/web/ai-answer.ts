import type { TurnResult } from "../ai/chat-turn.js";
import type { OwnerId } from "../core/types.js";
import type { Change } from "../mcp/changes.js";
import { type AskCardDeps, loadCard } from "./ai-card.js";

export type Segment = { text: string } | { card: string };
export type ChatAnswer =
  | {
      ok: true;
      ai: string;
      segments: Segment[];
      remember: string;
      cards: Record<string, string>;
      changes: Change[];
    }
  | {
      ok: false;
      ai: string;
      message: string;
      remember: string;
      cards: Record<string, string>;
      changes: Change[];
    };

const MARKER = /\[\[link:(\d+)\]\]/g;
const edgeBlanks = (text: string) =>
  text.replace(/^(?:[ \t]*\r?\n)+/, "").replace(/(?:\r?\n[ \t]*)+$/, "");

/** A card that can't be read is left out; the answer and its changes still reach the owner. */
async function readCard(deps: AskCardDeps, owner: OwnerId, id: string) {
  try {
    return await loadCard(deps, owner, id);
  } catch (error) {
    console.error("[ai-chat] a card couldn't be read:", error);
    return null;
  }
}

/** Core answers a Keep handy request it declines with the row as it was; that wrote nothing. */
const wroteSomething = (change: Change) =>
  change.kind !== "handy" ||
  (["status", "source", "since", "answeredAt", "waitDays"] as const).some(
    (key) => String(change.change.tool[key]) !== String(change.change.previous?.[key]),
  );

/** The id (or name) a change line names. */
const changeSubject = (change: Change): string => {
  switch (change.kind) {
    case "link":
    case "handy":
      return ` ${change.linkId}`;
    case "tag":
      return ` ${change.name}`;
    default:
      return "";
  }
};

/**
 * The reply split at its `[[link:ID]]` markers. A marker for a link the turn saw and the owner's
 * store returns becomes a card, the first time only; any other marker is removed. `remember` is
 * the same reply as plain text for the panel's history.
 */
async function split(deps: AskCardDeps, owner: OwnerId, reply: string, seen: Set<string>) {
  const segments: Segment[] = [];
  const shown = new Set<string>();
  let text = "";
  let remembered = "";
  const flush = () => {
    const trimmed = edgeBlanks(text);
    if (trimmed.trim() !== "") segments.push({ text: trimmed });
    text = "";
  };
  let end = 0;
  for (const match of reply.matchAll(MARKER)) {
    const between = reply.slice(end, match.index);
    end = match.index + match[0].length;
    text += between;
    remembered += between;
    const id = match[1] ?? "";
    if (!seen.has(id) || shown.has(id)) continue;
    const loaded = await readCard(deps, owner, id);
    if (!loaded) continue;
    shown.add(id);
    flush();
    segments.push({ card: loaded.html });
    remembered += match[0];
  }
  text += reply.slice(end);
  remembered += reply.slice(end);
  flush();
  return { segments, shown, remembered };
}

/** The chat answer the panel reads: what `POST /ai/chat` sends for a finished turn. */
export async function chatAnswer(
  deps: AskCardDeps,
  owner: OwnerId,
  ai: string,
  result: TurnResult,
): Promise<ChatAnswer> {
  const changes = result.changes.filter(wroteSomething);
  const parts = result.ok
    ? await split(deps, owner, result.reply, new Set(result.seen))
    : { segments: [], shown: new Set<string>(), remembered: "" };
  const cards: Record<string, string> = {};
  for (const change of changes) {
    if (change.kind !== "link" && change.kind !== "handy") continue;
    const id = change.linkId;
    if (parts.shown.has(id) || id in cards) continue;
    const loaded = await readCard(deps, owner, id);
    if (loaded) cards[id] = loaded.html;
  }
  if (result.ok) {
    const remember = parts.remembered.trim() || `${ai} gave no answer.`;
    return { ok: true, ai, segments: parts.segments, remember, cards, changes };
  }
  const message = `${ai} ${changes.length === 0 ? "didn't answer" : "stopped before it finished"}: ${result.reason}.`;
  const lines = changes.map((c) => `\n- ${c.kind}${changeSubject(c)}`).join("");
  return { ok: false, ai, message, remember: `${message}${lines}`, cards, changes };
}
