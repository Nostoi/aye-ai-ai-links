import { CoreError } from "./errors.js";
import type { LinkSearch, SearchFilters } from "./search.js";
import type { LinkStore } from "./store.js";
import type { Link, LinkState, OwnerId } from "./types.js";

export type LinkPage = {
  links: Link[];
  /** Pass as `before` for the next page; null when no older link passes the filters. */
  older: string | null;
};

const CURSOR = /^(\d{1,15})\.(.{1,200})$/s;

const encode = (link: Link) => `${link.savedAt.getTime()}.${link.id}`;

const badCursor = () =>
  new CoreError(
    "invalid_input",
    "That page of older links is not valid. Start again from the newest links.",
  );

/**
 * The link a cursor names, as `before`. A cursor is only valid when it names one of the owner's
 * links with the time it was saved at, so a hand-made one cannot reach the engine with an id
 * the store never issued.
 */
async function decode(store: LinkStore, owner: OwnerId, cursor: string) {
  const match = CURSOR.exec(cursor);
  if (!match) throw badCursor();
  const [, at, id] = match as unknown as [string, string, string];
  const link = await store.get(owner, id);
  if (!link || link.savedAt.getTime() !== Number(at)) throw badCursor();
  return { savedAt: link.savedAt, id: link.id };
}

/**
 * A page of the owner's links, newest first, optionally only those with a tag or in a state.
 * `before` is the `older` cursor of the previous page; it is opaque to callers, and one that is
 * malformed or names no link of this owner is refused with `invalid_input`.
 */
export async function newestLinks(
  { store, search }: { store: LinkStore; search: LinkSearch },
  owner: OwnerId,
  input: { tagKey?: string; state?: LinkState; before?: string; limit: number },
): Promise<LinkPage> {
  const filters: SearchFilters = {};
  if (input.tagKey !== undefined) filters.tagKey = input.tagKey;
  if (input.state !== undefined) filters.state = input.state;
  if (input.before !== undefined) filters.before = await decode(store, owner, input.before);
  const ids = await search.search(owner, "", filters, input.limit + 1);
  const links = (await Promise.all(ids.map((id) => store.get(owner, id)))).filter(
    (l): l is Link => l !== null,
  );
  const shown = links.slice(0, input.limit);
  const last = shown.at(-1);
  return { links: shown, older: ids.length > input.limit && last ? encode(last) : null };
}
