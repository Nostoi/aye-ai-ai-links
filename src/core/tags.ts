import { CoreError } from "./errors.js";
import type { LinkTag, Source } from "./types.js";

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

/** Clean names, derive keys, and merge duplicates (first name, strongest source). */
export function normalizeTags(input: { name: string; source: Source }[]): LinkTag[] {
  const byKey = new Map<string, LinkTag>();
  for (const { name: raw, source } of input) {
    const name = cleanName(raw);
    const key = tagKey(name);
    const existing = byKey.get(key);
    if (!existing) byKey.set(key, { key, name, source });
    else if (strength[source] > strength[existing.source]) existing.source = source;
  }
  return [...byKey.values()];
}
