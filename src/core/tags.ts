import { CoreError } from "./errors.js";
import { type LinkTag, type Source, TAG_KINDS, type TagKind } from "./types.js";

export const isTagKind = (k: string): k is TagKind => (TAG_KINDS as readonly string[]).includes(k);

const strength: Record<Source, number> = { stated: 3, asked: 2, inferred: 1 };

/** The more certain of two sources, stated over asked over inferred; `a` on a tie. */
export const strongerSource = (a: Source, b: Source): Source => (strength[b] > strength[a] ? b : a);

/** A tag name trimmed with its whitespace collapsed. Blank names are refused. */
export function cleanTagName(raw: string): string {
  const name = raw.trim().replace(/\s+/g, " ");
  if (name === "") {
    throw new CoreError(
      "invalid_input",
      "A tag name is empty. Give it a name such as 'home batteries', or leave the tag out.",
    );
  }
  return name;
}

/** The identity of a tag name: trimmed, whitespace collapsed, lower-cased. Blank names are refused. */
export const tagKey = (name: string): string => cleanTagName(name).toLowerCase();

/**
 * One tag per key. The winning mention (strongest source, the first on a tie) supplies the
 * source and the kind. `kindSource` is that mention's source when it gave a kind, and
 * "inferred" when the kind defaulted to topic: then nobody stated it.
 */
export function normalizeTags(
  input: { name: string; source: Source; kind?: TagKind }[],
): LinkTag[] {
  const byKey = new Map<string, LinkTag>();
  for (const { name: raw, source, kind } of input) {
    const name = cleanTagName(raw);
    const key = tagKey(name);
    const mention = {
      source,
      kind: kind ?? "topic",
      kindSource: kind === undefined ? "inferred" : source,
    } as const;
    const existing = byKey.get(key);
    if (!existing) byKey.set(key, { key, name, ...mention });
    else if (strongerSource(existing.source, source) !== existing.source)
      Object.assign(existing, mention);
  }
  return [...byKey.values()];
}

/**
 * The tag set a write leaves on a link, given the tags it has now and the set sent. A tag in both
 * keeps whichever side's source is stronger, so an owner's tag never turns into a guess. A guess
 * also keeps the owner's tags it leaves out and the current order; the owner's say replaces the
 * set in the order sent.
 */
export function mergeTags(current: LinkTag[], sent: LinkTag[], guess: boolean): LinkTag[] {
  const have = new Map(current.map((t) => [t.key, t]));
  const settle = (t: LinkTag): LinkTag => {
    const was = have.get(t.key);
    return was && strength[was.source] > strength[t.source] ? was : t;
  };
  if (!guess) return sent.map(settle);
  const sentByKey = new Map(sent.map((t) => [t.key, t]));
  const kept = current
    .filter((t) => t.source !== "inferred" || sentByKey.has(t.key))
    .map((t) => settle(sentByKey.get(t.key) ?? t));
  return [...kept, ...sent.filter((t) => !have.has(t.key))];
}
