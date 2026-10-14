import { CoreError } from "./errors.js";
import type { LinkStore } from "./store.js";
import { tagKey } from "./tags.js";
import type { OwnerId, Tag } from "./types.js";

/**
 * The colors a space (a pinned tag) can have, in the order a new pin takes them. Amber is never
 * one: it means "needs you".
 */
export const SPACE_COLORS = ["teal", "clay", "violet", "blue", "green", "rose"] as const;
export type SpaceColor = (typeof SPACE_COLORS)[number];

export const isSpaceColor = (value: unknown): value is SpaceColor =>
  (SPACE_COLORS as readonly unknown[]).includes(value);

const notFound = (name: string) =>
  new CoreError(
    "not_found",
    `No tag named "${name}" was found. A tag is created by tagging a link.`,
  );

/**
 * The color a new pin takes: the first color no tag holds, then the first no pinned tag holds,
 * then teal. Spaces share a color only once every color is taken.
 */
function freeColor(tags: Tag[]): SpaceColor {
  const held = (pinnedOnly: boolean) =>
    new Set(tags.filter((t) => !pinnedOnly || t.pinned).map((t) => t.color));
  const anyTag = held(false);
  const pinned = held(true);
  return (
    SPACE_COLORS.find((c) => !anyTag.has(c)) ?? SPACE_COLORS.find((c) => !pinned.has(c)) ?? "teal"
  );
}

/** Set a tag's color, one of `SPACE_COLORS`, whatever its kind or pin. */
export async function setTagColor(
  { store }: { store: LinkStore },
  owner: OwnerId,
  input: { name: string; color: SpaceColor },
): Promise<Tag> {
  const { name, color } = input;
  if (!isSpaceColor(color)) {
    throw new CoreError(
      "invalid_input",
      `The color "${String(color)}" is not a space color. Use one of: ${SPACE_COLORS.join(", ")}.`,
    );
  }
  const tag = await store.colorTag(owner, tagKey(name), color);
  if (!tag) throw notFound(name);
  return tag;
}

/**
 * Pin a tag, making it a space, or unpin it. A pin gives a tag with no color the free color
 * (`freeColor`), in the same write that pins it, so a color set meanwhile is kept. Unpinning keeps
 * the color, so pinning again brings it back.
 */
export async function setTagPinned(
  { store }: { store: LinkStore },
  owner: OwnerId,
  input: { name: string; pinned: boolean },
): Promise<Tag> {
  const { name, pinned } = input;
  const key = tagKey(name);
  const tag = pinned
    ? await store.pinTag(owner, key, {
        pinned: true,
        color: freeColor(await store.listTags(owner)),
      })
    : await store.pinTag(owner, key, { pinned: false });
  if (!tag) throw notFound(name);
  return tag;
}
