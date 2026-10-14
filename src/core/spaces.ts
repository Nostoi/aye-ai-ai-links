import { CoreError } from "./errors.js";
import type { LinkImageReader } from "./image-store.js";
import { type LinkPage, linkPage } from "./link-pages.js";
import { spaceColor } from "./link-space.js";
import type { LinkSearch } from "./search.js";
import type { LinkStore } from "./store.js";
import type { SpaceColor } from "./tag-space.js";
import { tagKey } from "./tags.js";
import type { LinkState, OwnerId, Tag } from "./types.js";

/** How many of a space's newest active links its mosaic looks through for images. */
export const MOSAIC_DEPTH = 50;
const MOSAIC_CELLS = 3;

/** A pinned tag as a tile on the home page. A null color shows neutral. */
export type HomeSpace = {
  key: string;
  name: string;
  color: SpaceColor | null;
  /** Up to three stored images, newest first; the tile tints the cells left over. */
  mosaic: { linkId: string; version: string }[];
};

type Deps = {
  store: LinkStore;
  search: LinkSearch;
  images: Pick<LinkImageReader, "imageVersions">;
};

/**
 * The owner's spaces (pinned tags), by key. Each mosaic holds the stored images of the newest
 * active links that have one, among the space's newest `MOSAIC_DEPTH` active links. The owner's
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
        limit: MOSAIC_DEPTH,
      });
      const versions = await deps.images.imageVersions(
        owner,
        links.map((l) => l.id),
      );
      const mosaic = links.flatMap((l) => {
        const version = versions.get(l.id);
        return version === undefined ? [] : [{ linkId: l.id, version }];
      });
      return {
        key: tag.key,
        name: tag.name,
        color: spaceColor(tag),
        mosaic: mosaic.slice(0, MOSAIC_CELLS),
      };
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
  deps: Omit<Deps, "images">,
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
