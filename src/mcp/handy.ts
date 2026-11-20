import { CoreError } from "../core/errors.js";
import type { GoneView } from "../core/link-check.js";
import { issueOpenCodes, openUrl } from "../core/open-codes.js";
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
import type { McpDeps } from "./server.js";

/**
 * Keep handy, and the other per-link views, at the MCP door: translates into core calls, and
 * holds no rule.
 */

/**
 * A link as the door returns it: with its Keep handy view (null for an ordinary link), its gone
 * view (null unless flagged) and its open link for the calling agent (#133; null when none).
 */
export type HandyLink = Link & {
  handy: HandyView | null;
  gone: GoneView | null;
  openUrl: string | null;
};

type ViewDeps = Pick<ToolsDeps, "tools" | "checks" | "now"> & Pick<McpDeps, "openLinks">;

/** Each web link's open link for `agent`, by link id; none without `openLinks`. */
async function openUrls(
  { openLinks, now }: ViewDeps,
  owner: OwnerId,
  links: Link[],
  agent: string,
): Promise<Map<string, string>> {
  if (!openLinks) return new Map();
  const codes = await issueOpenCodes({ openCodes: openLinks.codes, now }, owner, links, agent);
  return new Map([...codes].map(([id, code]) => [id, openUrl(openLinks.baseUrl, code)]));
}

/**
 * The link fields `linkOutput` declares, picked by name so an internal field never reaches its
 * strict schema.
 */
function mcpLink(l: Link): Link {
  return {
    id: l.id,
    url: l.url,
    urlKey: l.urlKey,
    title: l.title,
    summary: l.summary,
    summarySource: l.summarySource,
    why: l.why,
    tags: l.tags,
    savedAt: l.savedAt,
    savedBy: l.savedBy,
    lastOpenedAt: l.lastOpenedAt,
    lastSurfacedAt: l.lastSurfacedAt,
    snoozedUntil: l.snoozedUntil,
    intent: l.intent,
    intentSource: l.intentSource,
    state: l.state,
    snapshot: l.snapshot,
  };
}

/** `agent` is the calling agent, whose open link the result carries. */
export async function linkWithHandy(
  deps: ViewDeps,
  owner: OwnerId,
  link: Link,
  agent: string,
): Promise<HandyLink> {
  const opens = await openUrls(deps, owner, [link], agent);
  return {
    ...mcpLink(link),
    ...(await linkView(deps, owner, link)),
    openUrl: opens.get(link.id) ?? null,
  };
}

/** Each link with its views, from one read of the owner's rows, and its open link for `agent`. */
export async function linksWithHandy(
  deps: ViewDeps,
  owner: OwnerId,
  links: Link[],
  agent: string,
): Promise<HandyLink[]> {
  const views = await linkViews(deps, owner, links);
  const opens = await openUrls(deps, owner, links, agent);
  return links.map((l) => ({
    ...mcpLink(l),
    handy: null,
    gone: null,
    ...views.get(l.id),
    openUrl: opens.get(l.id) ?? null,
  }));
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
