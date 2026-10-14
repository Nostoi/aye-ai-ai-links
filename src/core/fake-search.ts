import type { FakeStore } from "./fake-store.js";
import type { LinkSearch, SearchFilters } from "./search.js";
import type { Link, OwnerId } from "./types.js";

/**
 * Blank-query LinkSearch over a FakeStore for tests: lists the owner's links that pass the
 * filters, newest first, ties broken by the order the store issued their ids. Word queries are
 * not modelled and throw.
 */
export class FakeSearch implements LinkSearch {
  constructor(private readonly store: FakeStore) {}

  async search(owner: OwnerId, query: string, filters: SearchFilters, limit: number) {
    if (query.trim() !== "") throw new Error("FakeSearch lists blank queries only.");
    const all = await this.store.listLinks(owner);
    const issued = new Map(all.map((l, i) => [l.id, i]));
    const place = (id: string) => issued.get(id) ?? -1;
    type Key = { savedAt: Date; id: string };
    const newest = (a: Key, b: Key) =>
      b.savedAt.getTime() - a.savedAt.getTime() || place(b.id) - place(a.id);
    const before = filters.before;
    return all
      .filter((l) => passes(l, filters))
      .sort(newest)
      .filter((l) => !before || newest(l, before) > 0)
      .map((l) => l.id)
      .slice(0, limit);
  }
}

function passes(l: Link, f: SearchFilters): boolean {
  const tagged = (key: string, project: boolean) =>
    l.tags.some((t) => t.key === key && (!project || t.kind === "project"));
  return (
    (f.tagKey === undefined || tagged(f.tagKey, false)) &&
    (f.projectKey === undefined || tagged(f.projectKey, true)) &&
    (f.savedFrom === undefined || l.savedAt >= f.savedFrom) &&
    (f.savedTo === undefined || l.savedAt <= f.savedTo) &&
    (f.state === undefined || l.state === f.state)
  );
}
