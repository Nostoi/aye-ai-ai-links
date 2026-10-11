import { CoreError } from "./errors.js";
import type { LinkTag, Source } from "./types.js";

const strength: Record<Source, number> = { stated: 3, asked: 2, inferred: 1 };

/** Clean names, derive keys, and merge duplicates (first name, strongest source). */
export function normalizeTags(input: { name: string; source: Source }[]): LinkTag[] {
  const byKey = new Map<string, LinkTag>();
  for (const { name: raw, source } of input) {
    const name = raw.trim().replace(/\s+/g, " ");
    if (name === "") {
      throw new CoreError(
        "invalid_input",
        "A tag name is empty. Remove the blank tag or give it a name such as 'home batteries'.",
      );
    }
    const key = name.toLowerCase();
    const existing = byKey.get(key);
    if (!existing) byKey.set(key, { key, name, source });
    else if (strength[source] > strength[existing.source]) existing.source = source;
  }
  return [...byKey.values()];
}
