import { CoreError } from "./errors.js";
import { type Deps, saveLink } from "./links.js";
import type { Link, OwnerId } from "./types.js";
import { tellWhy } from "./worth-a-look.js";

/** What the Save page sends (#129). A blank title or why means none. */
export type SavePageInput = {
  url: string;
  title: string | null;
  why: string | null;
  savedBy: string;
};

/** The link as saved. `whyKept` is false when the owner's why was not kept (see `savePage`). */
export type SavedPage = { link: Link; created: boolean; whyKept: boolean };

/**
 * Saves the page the owner sent from the Save page. The owner's why is recorded as "asked", as
 * Tell me why records it. Dedupe is saveLink's: a repeat save returns the link already saved, and
 * fills a missing why. On a repeat save over an agent's guess, the owner's why replaces it through
 * `tellWhy`. A reason someone gave is never replaced: then `whyKept` is false. It never waits for
 * the page's fetch, since the Save page does not show the page's text; the fetch is still started.
 */
export async function savePage(
  deps: Deps,
  owner: OwnerId,
  input: SavePageInput,
): Promise<SavedPage> {
  const why = input.why?.trim() || null;
  const saved = await saveLink({ ...deps, saveWaitMs: 0 }, owner, {
    url: input.url,
    title: input.title,
    why: why === null ? null : { text: why, source: "asked" },
    savedBy: input.savedBy,
  });
  let link = saved.link;
  if (!saved.created && why !== null && link.why?.source === "inferred") {
    link = await replaceGuess(deps, owner, link, why);
  }
  return { link, created: saved.created, whyKept: why === null || link.why?.text === why };
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
