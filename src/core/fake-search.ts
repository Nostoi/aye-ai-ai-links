import type { FakeStore } from "./fake-store.js";
import type {
  LinkCount,
  LinkListing,
  LinkOrder,
  LinkSearch,
  ListedLink,
  SearchFilters,
} from "./search.js";
import type { Link, OwnerId } from "./types.js";

/** The time each order sorts by, null for a link not in its list, and +1 for ascending. */
const ORDERS: Record<LinkOrder, { key: (l: Link) => Date | null; sign: 1 | -1 }> = {
  newest: { key: (l) => l.savedAt, sign: -1 },
  oldest: { key: (l) => l.savedAt, sign: 1 },
  opened: { key: (l) => l.lastOpenedAt, sign: -1 },
};

/**
 * Blank-query LinkSearch, LinkCount and LinkListing over a FakeStore for tests: lists the owner's
 * links that pass the filters in the order asked for, ties broken by the order the store issued
 * their ids, as FtsSearch does. Word queries are not modelled and throw.
 */
export class FakeSearch implements LinkSearch, LinkCount, LinkListing {
  constructor(private readonly store: FakeStore) {}

  async search(owner: OwnerId, query: string, filters: SearchFilters, limit: number) {
    if (query.trim() !== "") throw new Error("FakeSearch lists blank queries only.");
    return (await this.list(owner, filters, limit)).map((p) => p.id);
  }

  async list(owner: OwnerId, filters: SearchFilters, limit: number): Promise<ListedLink[]> {
    const all = await this.store.listLinks(owner);
    const issued = new Map(all.map((l, i) => [l.id, i]));
    const place = (id: string) => issued.get(id) ?? -1;
    const { sign } = ORDERS[filters.order ?? "newest"];
    const sorted = (a: ListedLink, b: ListedLink) =>
      sign * (a.at.getTime() - b.at.getTime() || place(a.id) - place(b.id));
    const before = filters.before;
    return listed(all, filters)
      .sort(sorted)
      .filter((p) => !before || sorted(p, before) > 0)
      .slice(0, limit);
  }

  async count(owner: OwnerId, filters: Omit<SearchFilters, "before">) {
    return listed(await this.store.listLinks(owner), filters).length;
  }
}

/** The positions of the links that pass the filters and are in the order's list. */
function listed(all: Link[], filters: SearchFilters): ListedLink[] {
  const { key } = ORDERS[filters.order ?? "newest"];
  return all.flatMap((l) => {
    const at = key(l);
    return at && passes(l, filters) ? [{ at, id: l.id }] : [];
  });
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
