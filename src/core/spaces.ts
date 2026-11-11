import { CoreError } from "./errors.js";
import { type LinkPage, linkPage } from "./link-pages.js";
import { spaceColor } from "./link-space.js";
import type { LinkListing, LinkOrder } from "./search.js";
import type { LinkStore } from "./store.js";
import type { SpaceColor } from "./tag-space.js";
import { tagKey } from "./tags.js";
import type { Link, LinkState, OwnerId, Tag } from "./types.js";

/** How many of a space's links its home card names. */
const RECENT_SIZE = 3;

/** A pinned tag as a card on the home page. A null color shows neutral. */
export type HomeSpace = {
  key: string;
  name: string;
  color: SpaceColor | null;
  /**
   * Up to three of its active links, newest first. Best effort: a card prefers links no other
   * card shows (`homeSpaces`), so these are not always the space's three newest.
   */
  recent: Link[];
};

type Deps = {
  store: LinkStore;
  listing: LinkListing;
};

/** The most newest links fetched for any one space, to choose its card's links from. */
const POOL_MAX = 24;

/**
 * Picks each card's links from its pool (`pools`, newest first), so cards tell spaces apart. Cards
 * are served fewest candidates first (ties: card order); each takes up to three links no card
 * served before it shows, then fills with ones already shown, newest first. A card's picks come
 * back newest first, and the result keeps the order of `pools`.
 */
function pickRecent(pools: Link[][]): Link[][] {
  const shown = new Set<string>();
  const picked: Link[][] = pools.map(() => []);
  const serving = pools
    .map((_, i) => i)
    .sort((a, b) => (pools[a]?.length ?? 0) - (pools[b]?.length ?? 0) || a - b);
  for (const i of serving) {
    const pool = pools[i] ?? [];
    const fresh = pool.filter((l) => !shown.has(l.id));
    const seen = pool.filter((l) => shown.has(l.id));
    const chosen = new Set([...fresh, ...seen].slice(0, RECENT_SIZE).map((l) => l.id));
    picked[i] = pool.filter((l) => chosen.has(l.id));
    for (const l of picked[i] ?? []) shown.add(l.id);
  }
  return picked;
}

/**
 * The owner's spaces (pinned tags), by key, each with up to three of its active links, newest
 * first. Best effort: a space whose newest links another card also shows takes its other links
 * instead (`pickRecent`), chosen by link identity from its newest `min(3 × spaces, 24)`. The
 * owner's catalog comes too, for `linkSpace`.
 */
export async function homeSpaces(
  deps: Deps,
  owner: OwnerId,
): Promise<{ spaces: HomeSpace[]; catalog: Tag[] }> {
  const catalog = await deps.store.listTags(owner);
  const pinned = catalog.filter((t) => t.pinned);
  const poolSize = Math.min(RECENT_SIZE * pinned.length, POOL_MAX);
  const pools = await Promise.all(
    pinned.map(
      async (tag) =>
        (await linkPage(deps, owner, { tagKey: tag.key, state: "active", limit: poolSize })).links,
    ),
  );
  const recent = pickRecent(pools);
  const spaces = pinned.map(
    (tag, i): HomeSpace => ({
      key: tag.key,
      name: tag.name,
      color: spaceColor(tag),
      recent: recent[i] ?? [],
    }),
  );
  return { spaces, catalog };
}

/**
 * The owner's tag called `name` (any case, spaces trimmed), pinned or not, in their `catalog`. A
 * tag the owner does not have is `not_found`, whether or not another owner has it; the message
 * never repeats the name.
 */
export function findSpaceTag(catalog: Tag[], name: string): Tag {
  const key = tagKey(name);
  const tag = catalog.find((t) => t.key === key);
  if (!tag) throw new CoreError("not_found", "No tag with that name was found.");
  return tag;
}

/**
 * One of the owner's tags as a space, pinned or not, with a page of its links in `state` and
 * `order` (newest when left out). The owner's catalog comes too, for `linkSpace`. A tag the owner
 * does not have is `not_found` (`findSpaceTag`).
 */
export async function openSpace(
  deps: Deps,
  owner: OwnerId,
  input: { name: string; state: LinkState; order?: LinkOrder; before?: string; limit: number },
): Promise<{ tag: Tag; catalog: Tag[]; page: LinkPage }> {
  const catalog = await deps.store.listTags(owner);
  const tag = findSpaceTag(catalog, input.name);
  const page = await linkPage(deps, owner, {
    tagKey: tag.key,
    state: input.state,
    limit: input.limit,
    ...(input.order === undefined ? {} : { order: input.order }),
    ...(input.before === undefined ? {} : { before: input.before }),
  });
  return { tag, catalog, page };
}
