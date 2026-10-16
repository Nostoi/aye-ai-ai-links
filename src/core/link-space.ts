import { isSpaceColor, type SpaceColor } from "./tag-space.js";
import type { Link, Tag } from "./types.js";

/** A space a link is shown in: a pinned tag with a valid space color. */
export type Space = { key: string; name: string; color: SpaceColor };

/**
 * A pinned tag's color when it is one of `SPACE_COLORS`; anything else is null. An unpinned tag
 * keeps its stored color, which shows again once it is pinned.
 */
export const spaceColor = (tag: Pick<Tag, "color" | "pinned">): SpaceColor | null =>
  tag.pinned && isSpaceColor(tag.color) ? tag.color : null;

/**
 * The space whose color a link is shown in. `within` (a tag key, such as the space page being
 * shown) wins when it names one of the link's pinned tags; otherwise the first of the link's
 * pinned tags in the order they were attached. A pinned tag whose color is not a space color is
 * skipped, so amber never appears. Null means neutral. `catalog` is the owner's tags.
 */
export function linkSpace(
  link: Pick<Link, "tags">,
  catalog: Tag[],
  { within }: { within?: string } = {},
): Space | null {
  const byKey = new Map(catalog.map((t) => [t.key, t]));
  const spaces = link.tags.flatMap((t): Space[] => {
    const entry = byKey.get(t.key);
    const color = entry ? spaceColor(entry) : null;
    return entry && color ? [{ key: entry.key, name: entry.name, color }] : [];
  });
  return spaces.find((s) => s.key === within) ?? spaces[0] ?? null;
}
