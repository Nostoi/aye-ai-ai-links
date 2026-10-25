import { CoreError } from "./errors.js";
import { LINK_ORDERS, type LinkListing, type LinkOrder, type SearchFilters } from "./search.js";
import type { LinkStore } from "./store.js";
import type { Link, OwnerId } from "./types.js";

export type LinkPage = {
  links: Link[];
  /** Pass as `before` for the next page; null when no further link passes the filters. */
  older: string | null;
};

/**
 * How each order writes its cursors. Newest has no prefix, so cursors made before there were
 * orders stay valid. `key` is the time a link sorts by, or null for a link not in the list.
 */
const CURSORS: Record<
  LinkOrder,
  { prefix: string; key: (link: Link) => Date | null; restart: string }
> = {
  newest: {
    prefix: "",
    key: (l) => l.savedAt,
    restart: "That page of older links is not valid. Start again from the newest links.",
  },
  oldest: {
    prefix: "o",
    key: (l) => l.savedAt,
    restart: "That page of links is not valid. Start again from the oldest links.",
  },
  opened: {
    prefix: "r",
    key: (l) => l.lastOpenedAt,
    restart: "That page of links is not valid. Start again from the start of the list.",
  },
};

const CURSOR = /^([or]?)(\d{1,15})\.(.{1,200})$/s;

/** The order asked for, newest when left out; anything else is `invalid_input`. */
export function checkedOrder(order: string | undefined): LinkOrder {
  if (order === undefined) return "newest";
  if ((LINK_ORDERS as readonly string[]).includes(order)) return order as LinkOrder;
  throw new CoreError("invalid_input", "order must be newest, oldest or opened, or left out.");
}

/**
 * The position a cursor names, as `before`. A cursor is only valid for the order that made it
 * and when it names one of the owner's live links, so a hand-made one cannot reach the engine with an
 * id the store never issued. Its time must be the link's save time, or for opened at most its
 * last opening: openings only move forward, so a link opened again keeps the walk going.
 */
async function decode(store: LinkStore, owner: OwnerId, order: LinkOrder, cursor: string) {
  const { prefix, key, restart } = CURSORS[order];
  const bad = () => new CoreError("invalid_input", restart);
  const match = CURSOR.exec(cursor);
  if (!match || match[1] !== prefix) throw bad();
  const [, , ms, id] = match as unknown as [string, string, string, string];
  const link = await store.get(owner, id);
  if (!link) throw new CoreError("not_found", restart);
  const at = key(link)?.getTime();
  const fits = order === "opened" ? Number(ms) <= (at ?? -1) : Number(ms) === at;
  if (at === undefined || !fits) throw bad();
  return { at: new Date(Number(ms)), id: link.id };
}

/**
 * A page of the owner's links in `order` (newest when left out) that pass the filters.
 * `before` is the `older` cursor of the previous page; it is opaque to callers, and one that is
 * malformed, made for another order or not fitting the link it names is refused with
 * `invalid_input`, and one naming no live link of this owner with `not_found`.
 */
export async function linkPage(
  { store, listing }: { store: LinkStore; listing: LinkListing },
  owner: OwnerId,
  input: Omit<SearchFilters, "before"> & { before?: string; limit: number },
): Promise<LinkPage> {
  const { before, limit, ...filters } = input;
  const order = filters.order ?? "newest";
  const query: SearchFilters = {
    ...filters,
    ...(before === undefined ? {} : { before: await decode(store, owner, order, before) }),
  };
  const listed = await listing.list(owner, query, limit + 1);
  const links = (await Promise.all(listed.map(({ id }) => store.get(owner, id)))).filter(
    (l): l is Link => l !== null,
  );
  const shown = links.slice(0, limit);
  const last = shown.at(-1);
  // The listed time, not the read link's: an opening between the two moves the read one (#215).
  const at = last && listed.find((p) => p.id === last.id)?.at;
  const more = listed.length > limit && last && at;
  return {
    links: shown,
    older: more ? `${CURSORS[order].prefix}${at.getTime()}.${last.id}` : null,
  };
}
