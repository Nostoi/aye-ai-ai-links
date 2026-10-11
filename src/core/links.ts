import { CoreError } from "./errors.js";
import type { LinkStore } from "./store.js";
import { normalizeTags } from "./tags.js";
import type { Labelled, Link, LinkPatch, OwnerId, Source } from "./types.js";
import { urlKey } from "./url-key.js";

export type Deps = { store: LinkStore; now: () => Date };

type TagInput = { name: string; source: Source }[];

export type SaveLinkInput = {
  url: string;
  title?: string | null;
  summary?: string | null;
  why?: Labelled | null;
  tags?: TagInput;
  savedBy: string;
};

export type UpdateLinkInput = Omit<LinkPatch, "tags"> & { tags?: TagInput };

/** Trim the why text; empty text means the why is missing. */
function cleanWhy(why: Labelled | null | undefined): Labelled | null {
  const text = why?.text.trim();
  return why && text ? { text, source: why.source } : null;
}

export async function saveLink(
  { store, now }: Deps,
  owner: OwnerId,
  input: SaveLinkInput,
): Promise<{ link: Link; created: boolean }> {
  const key = urlKey(input.url);
  const tags = normalizeTags(input.tags ?? []);
  const why = cleanWhy(input.why);
  const result = await store.insertIfAbsent(owner, {
    url: input.url.trim(),
    urlKey: key,
    title: input.title ?? null,
    summary: input.summary ?? null,
    why,
    tags,
    savedAt: now(),
    savedBy: input.savedBy,
    lastOpenedAt: null,
    lastSurfacedAt: null,
    snoozedUntil: null,
    state: "active",
  });
  if (result.created || !why || result.link.why) return result;
  const filled = await store.fillWhyIfMissing(owner, result.link.id, why);
  return { link: filled ?? result.link, created: false };
}

export async function getLink({ store }: Deps, owner: OwnerId, id: string): Promise<Link> {
  const link = await store.get(owner, id);
  if (!link) throw notFound(id);
  return link;
}

export async function updateLink(
  { store }: Deps,
  owner: OwnerId,
  id: string,
  input: UpdateLinkInput,
): Promise<Link> {
  const { tags, why, ...rest } = input;
  const patch: LinkPatch = { ...rest };
  if (tags !== undefined) patch.tags = normalizeTags(tags);
  if (why !== undefined) patch.why = cleanWhy(why);
  const link = await store.update(owner, id, patch);
  if (!link) throw notFound(id);
  return link;
}

function notFound(id: string): CoreError {
  return new CoreError(
    "not_found",
    `No link with id "${id}" was found. Use search_links to find the right id.`,
  );
}
