import { type HandyView, handyOf, handyOfLinks, type ToolsDeps } from "../core/tools.js";
import type { Link, OwnerId } from "../core/types.js";

/** Keep handy at the MCP door: translates into core/tools.ts calls, and holds no rule. */

/** A link as the door returns it: with its Keep handy view (null for an ordinary link). */
export type HandyLink = Link & { handy: HandyView | null };

type ViewDeps = Pick<ToolsDeps, "tools" | "now">;

export async function linkWithHandy(
  deps: ViewDeps,
  owner: OwnerId,
  link: Link,
): Promise<HandyLink> {
  return { ...link, handy: await handyOf(deps, owner, link) };
}

/** Each link with its view, from one read of the owner's rows. */
export async function linksWithHandy(
  deps: ViewDeps,
  owner: OwnerId,
  links: Link[],
): Promise<HandyLink[]> {
  const views = await handyOfLinks(deps, owner, links);
  return links.map((l) => ({ ...l, handy: views.get(l.id) ?? null }));
}
