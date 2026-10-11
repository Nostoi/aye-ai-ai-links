import { CoreError } from "./errors.js";
import type { LinkTag, Source, TagKind } from "./types.js";

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

export function normalizeTags(
  input: { name: string; source: Source; kind?: TagKind }[],
): LinkTag[] {
  const byKey = new Map<string, LinkTag>();
  for (const { name: raw, source, kind = "topic" } of input) {
    const name = cleanName(raw);
    const key = tagKey(name);
    const existing = byKey.get(key);
    if (!existing) byKey.set(key, { key, name, source, kind });
    else if (strength[source] > strength[existing.source]) {
      existing.source = source;
      existing.kind = kind;
    }
  }
  return [...byKey.values()];
}
