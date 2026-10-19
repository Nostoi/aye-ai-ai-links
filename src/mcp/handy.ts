import { CoreError } from "../core/errors.js";
import type { GoneView } from "../core/link-check.js";
import {
  type HandyView,
  keepHandy,
  linkView,
  linkViews,
  notHandy,
  stillUsing,
  type ToolChange,
  type ToolsDeps,
} from "../core/tools.js";
import type { Link, OwnerId, Source } from "../core/types.js";

/** Keep handy at the MCP door: translates into core/tools.ts calls, and holds no rule. */

/** A link as the door returns it: with its Keep handy view (null for an ordinary link) and its gone view (null unless flagged). */
export type HandyLink = Link & { handy: HandyView | null; gone: GoneView | null };

type ViewDeps = Pick<ToolsDeps, "tools" | "checks" | "now">;

export async function linkWithHandy(
  deps: ViewDeps,
  owner: OwnerId,
  link: Link,
): Promise<HandyLink> {
  return { ...link, ...(await linkView(deps, owner, link)) };
}

/** Each link with its views, from one read of the owner's rows. */
export async function linksWithHandy(
  deps: ViewDeps,
  owner: OwnerId,
  links: Link[],
): Promise<HandyLink[]> {
  const views = await linkViews(deps, owner, links);
  return links.map((l) => ({ ...l, handy: null, gone: null, ...views.get(l.id) }));
}

/** The `handy` input's actions. */
export const HANDY_ACTIONS = ["keep", "still_using", "not_handy"] as const;
export type HandyInput = { action: (typeof HANDY_ACTIONS)[number]; source: Source };

type ToolAction = (
  deps: ToolsDeps,
  owner: OwnerId,
  id: string,
  source: Source,
) => Promise<ToolChange>;
const ACTIONS: Record<HandyInput["action"], ToolAction> = {
  keep: keepHandy,
  still_using: stillUsing,
  not_handy: notHandy,
};

/** One core call per action; core decides what each does with the source. */
export function applyHandy(
  deps: ToolsDeps,
  owner: OwnerId,
  id: string,
  { action, source }: HandyInput,
): Promise<ToolChange> {
  return ACTIONS[action](deps, owner, id, source);
}

/**
 * `applyHandy` on a link `save_link` has just created. The link is stored by then, so a refusal
 * says so, with the id, rather than reading as a failed save the agent would retry. Returns the
 * change it made.
 */
export async function applyHandyToSaved(
  deps: ToolsDeps,
  owner: OwnerId,
  id: string,
  handy: HandyInput,
): Promise<ToolChange> {
  try {
    return await applyHandy(deps, owner, id, handy);
  } catch (error) {
    if (!(error instanceof CoreError)) throw error;
    throw new CoreError(
      error.code,
      `The link was saved with id "${id}", but its handy change was not made: ${error.message} To change it, call update_link with that id.`,
    );
  }
}
