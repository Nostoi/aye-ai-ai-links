import type { ListRanks } from "../core/search.js";

/** For each returned id, its 1-based place in every list that holds it. */
export function listRanks(
  returned: string[],
  lists: { field?: string[]; page?: string[]; meaning?: string[] },
): Record<string, ListRanks> {
  const ranks: Record<string, ListRanks> = {};
  for (const id of returned) ranks[id] = {};
  for (const [name, list] of Object.entries(lists) as [keyof ListRanks, string[]][]) {
    for (const [i, id] of list.entries()) {
      const entry = ranks[id];
      if (entry) entry[name] = i + 1;
    }
  }
  return ranks;
}
