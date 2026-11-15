import { CoreError } from "./errors.js";
import { type LinkPage, linkPage } from "./link-pages.js";
import { spaceColor } from "./link-space.js";
import type { LinkCount, LinkListing, LinkOrder } from "./search.js";
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
  /** How many active links it has: a total, not a count of unread ones. */
  count: number;
  /**
   * Up to three of its active links, newest first, none shown above it on Home or on an earlier
   * card (`homeSpaces`): fewer than three, or none, when the others are shown elsewhere.
   */
  recent: Link[];
};

type Deps = {
  store: LinkStore;
  listing: LinkListing;
};

/** The most newest links fetched for any one space, to choose its card's links from. */
const POOL_MAX = 48;

/**
 * Picks each card's links from its pool (`pools`, newest first), so no link shows twice on Home.
 * A link in `shown` (shown higher on the page) is dropped from every pool. Cards are then served
 * fewest remaining candidates first (counted once; ties: card order); each takes up to three
 * links no earlier card took, newest first, and never refills with a repeat, so a card may get
 * fewer than three, or none. The result keeps the order of `pools`.
 */
function pickRecent(pools: Link[][], shown: ReadonlySet<string>): Link[][] {
  const left = pools.map((pool) => pool.filter((l) => !shown.has(l.id)));
  const taken = new Set<string>();
  const picked: Link[][] = pools.map(() => []);
  const serving = left
    .map((_, i) => i)
    .sort((a, b) => (left[a]?.length ?? 0) - (left[b]?.length ?? 0) || a - b);
  for (const i of serving) {
    const own = (left[i] ?? []).filter((l) => !taken.has(l.id)).slice(0, RECENT_SIZE);
    picked[i] = own;
    for (const l of own) taken.add(l.id);
  }
  return picked;
}

/**
 * The owner's spaces (pinned tags), by key, each with up to three of its active links, newest
 * first, none in `shown` (the ids Home shows above the spaces: every kept Handy item, the
 * suggestions, Worth a look and its gone link) or on an earlier card (`pickRecent`). Chosen by
 * link identity from its newest `min(3 × spaces + shown.size, 48)`, so a card can have fewer than
 * three links, or none; its count stays every active link. The limit is per page load: after a
 * shelf action on the page, a card may show a link the refreshed shelf now shows, until Home is
 * loaded again. The owner's catalog comes too, for `linkSpace`.
 */
export async function homeSpaces(
  deps: Deps & { count: LinkCount },
  owner: OwnerId,
  shown: ReadonlySet<string>,
): Promise<{ spaces: HomeSpace[]; catalog: Tag[] }> {
  const catalog = await deps.store.listTags(owner);
  const pinned = catalog.filter((t) => t.pinned);
  const poolSize = Math.min(RECENT_SIZE * pinned.length + shown.size, POOL_MAX);
  const pools = await Promise.all(
    pinned.map(
      async (tag) =>
        (await linkPage(deps, owner, { tagKey: tag.key, state: "active", limit: poolSize })).links,
    ),
  );
  const counts = await Promise.all(
    pinned.map((tag) => deps.count.count(owner, { tagKey: tag.key, state: "active" })),
  );
  const recent = pickRecent(pools, shown);
  const spaces = pinned.map(
    (tag, i): HomeSpace => ({
      key: tag.key,
      name: tag.name,
      color: spaceColor(tag),
      count: counts[i] ?? 0,
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
