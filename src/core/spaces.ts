import { CoreError } from "./errors.js";
import { type LinkPage, linkPage } from "./link-pages.js";
import { spaceColor } from "./link-space.js";
import type { LinkSearch } from "./search.js";
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
  /** Up to three of its active links, newest first. */
  recent: Link[];
};

type Deps = {
  store: LinkStore;
  search: LinkSearch;
};

/**
 * The owner's spaces (pinned tags), by key, each with its newest active links. The owner's
 * catalog comes too, for `linkSpace`.
 */
export async function homeSpaces(
  deps: Deps,
  owner: OwnerId,
): Promise<{ spaces: HomeSpace[]; catalog: Tag[] }> {
  const catalog = await deps.store.listTags(owner);
  const pinned = catalog.filter((t) => t.pinned);
  const spaces = await Promise.all(
    pinned.map(async (tag): Promise<HomeSpace> => {
      const { links } = await linkPage(deps, owner, {
        tagKey: tag.key,
        state: "active",
        limit: RECENT_SIZE,
      });
      return { key: tag.key, name: tag.name, color: spaceColor(tag), recent: links };
    }),
  );
  return { spaces, catalog };
}

/**
 * One of the owner's tags as a space, pinned or not, with a page of its links in `state`. The
 * owner's catalog comes too, for `linkSpace`. A tag the owner does not have is `not_found`,
 * whether or not another owner has it; the message never repeats the name.
 */
export async function openSpace(
  deps: Deps,
  owner: OwnerId,
  input: { name: string; state: LinkState; before?: string; limit: number },
): Promise<{ tag: Tag; catalog: Tag[]; page: LinkPage }> {
  const key = tagKey(input.name);
  const catalog = await deps.store.listTags(owner);
  const tag = catalog.find((t) => t.key === key);
  if (!tag) throw new CoreError("not_found", "No tag with that name was found.");
  const page = await linkPage(deps, owner, {
    tagKey: key,
    state: input.state,
    limit: input.limit,
    ...(input.before === undefined ? {} : { before: input.before }),
  });
  return { tag, catalog, page };
}
