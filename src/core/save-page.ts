import { CoreError } from "./errors.js";
import { cleanWhy, type Deps, notFound, saveLink } from "./links.js";
import { normalizeTags } from "./tags.js";
import type { Link, OwnerId } from "./types.js";
import { tellWhy } from "./worth-a-look.js";

/** What the Save page sends (#129). A blank title or why means none. */
export type SavePageInput = {
  url: string;
  title: string | null;
  why: string | null;
  /** Tag names the owner typed; each is saved as stated. */
  tags?: string[];
  savedBy: string;
};

/**
 * The link as saved. `whyKept` is false when the owner's why was not kept (see `savePage`).
 * `tagsAdded` names the typed tags this save attached and `tagsHad` the typed tags the link
 * already had, each as the link names it.
 */
export type SavedPage = {
  link: Link;
  created: boolean;
  whyKept: boolean;
  tagsAdded: string[];
  tagsHad: string[];
};

/**
 * Saves the page the owner sent from the Save page. The owner's why is recorded as "asked", as
 * Tell me why records it. Dedupe is saveLink's: a repeat save returns the link already saved, and
 * fills a missing why. On a repeat save over an agent's guess, the owner's why replaces it through
 * `tellWhy`. A reason someone gave is never replaced: then `whyKept` is false. The typed tags are
 * the owner's, stated; a repeat save attaches the ones the link lacks and leaves every tag it has
 * as it is. It never waits for the page's fetch, since the Save page does not show the page's
 * text; the fetch is still started.
 */
export async function savePage(
  deps: Deps,
  owner: OwnerId,
  input: SavePageInput,
): Promise<SavedPage> {
  const why = cleanWhy({ text: input.why ?? "", source: "asked" })?.text ?? null;
  const typed = normalizeTags((input.tags ?? []).map((name) => ({ name, source: "stated" })));
  const saved = await saveLink({ ...deps, saveWaitMs: 0 }, owner, {
    url: input.url,
    title: input.title,
    why: why === null ? null : { text: why, source: "asked" },
    tags: typed.map(({ name, source }) => ({ name, source })),
    savedBy: input.savedBy,
  });
  let link = saved.link;
  if (!saved.created && why !== null && link.why?.source === "inferred") {
    link = await replaceGuess(deps, owner, link, why);
  }
  let added = typed.map((t) => t.key);
  if (!saved.created && typed.length > 0) {
    const result = await deps.store.addTags(owner, link.id, typed);
    if (!result) throw notFound(link.id);
    link = result.link;
    added = result.added;
  }
  const named = (keys: string[]) =>
    keys.flatMap((key) => link.tags.filter((t) => t.key === key).map((t) => t.name));
  return {
    link,
    created: saved.created,
    whyKept: why === null || link.why?.text === why,
    tagsAdded: named(added),
    tagsHad: named(typed.map((t) => t.key).filter((key) => !added.includes(key))),
  };
}

/** Tell me why over an agent's guess. If a reason was given meanwhile, that reason stays. */
async function replaceGuess(deps: Deps, owner: OwnerId, link: Link, why: string): Promise<Link> {
  try {
    return await tellWhy(deps, owner, link.id, why);
  } catch (error) {
    if (!(error instanceof CoreError) || error.code !== "conflict") throw error;
    return (await deps.store.get(owner, link.id)) ?? link;
  }
}
