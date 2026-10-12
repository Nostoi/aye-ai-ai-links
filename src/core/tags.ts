import { CoreError } from "./errors.js";
import { type LinkTag, type Source, TAG_KINDS, type TagKind } from "./types.js";

export const isTagKind = (k: string): k is TagKind => (TAG_KINDS as readonly string[]).includes(k);

const strength: Record<Source, number> = { stated: 3, asked: 2, inferred: 1 };

function cleanName(raw: string): string {
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
export const tagKey = (name: string): string => cleanName(name).toLowerCase();

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
    const name = cleanName(raw);
    const key = tagKey(name);
    const mention = {
      source,
      kind: kind ?? "topic",
      kindSource: kind === undefined ? "inferred" : source,
    } as const;
    const existing = byKey.get(key);
    if (!existing) byKey.set(key, { key, name, ...mention });
    else if (strength[source] > strength[existing.source]) Object.assign(existing, mention);
  }
  return [...byKey.values()];
}
