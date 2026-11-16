import { randomBytes } from "node:crypto";
import { type Deps, recordOpening } from "./links.js";
import { logOpenFromResults } from "./search-log.js";
import type { Link, OwnerId } from "./types.js";
import { isWebUrl } from "./url-key.js";

/**
 * Open links (#133): an agent hands the owner `<base>/o/<code>` for a saved web link, and the
 * page there records the opening when it is clicked. The code stands for one link and one agent.
 */

/** Where an open code's page is served. */
export const OPEN_PATH = "/o/";

/** A code as issued: 16 random bytes (128 bits), base64url, so 22 characters. */
export const OPEN_CODE_SHAPE = /^[A-Za-z0-9_-]{22}$/;

export const newOpenCode = (): string => randomBytes(16).toString("base64url");

/** Who an open code opens for, found from the code alone (`src/auth/open-code.ts`). */
export type Opener = { owner: OwnerId; linkId: string; agent: string };

export interface OpenCodeStore {
  /**
   * Each link's code for this agent, by link id: the one stored, else a new one from `newCode`,
   * stored now. A link the owner doesn't have, or has deleted, gets none. Two calls at once for
   * the same link and agent store one code and both return it.
   */
  codesFor(
    owner: OwnerId,
    agent: string,
    linkIds: string[],
    newCode: () => string,
    at: Date,
  ): Promise<Map<string, string>>;
}

/** Each web link's code for this agent, by link id. A link that isn't a web page gets none. */
export async function issueOpenCodes(
  deps: { openCodes: OpenCodeStore; now: () => Date },
  owner: OwnerId,
  links: Link[],
  agent: string,
): Promise<Map<string, string>> {
  const web = links.filter((l) => isWebUrl(l.url)).map((l) => l.id);
  if (web.length === 0) return new Map();
  return deps.openCodes.codesFor(owner, agent, web, newOpenCode, deps.now());
}

/** The address an agent hands out for a code. */
export const openUrl = (baseUrl: string, code: string) => `${baseUrl}${OPEN_PATH}${code}`;

/** The link a code's page forwards to: the opener's link while it is a web link, else null. */
export async function openTarget({ store }: Deps, opener: Opener): Promise<Link | null> {
  const link = await store.get(opener.owner, opener.linkId);
  return link && isWebUrl(link.url) ? link : null;
}

/**
 * The page's report that a browser followed the code: records the opening for the owner, as a
 * click on the web page does, whoever clicked (owner ruling, #133). Pairs it with the agent's
 * newest search whose results held the link. Throws not_found for a link gone meanwhile.
 */
export async function openFromCode(deps: Deps, opener: Opener): Promise<void> {
  const at = deps.now();
  const link = await recordOpening({ ...deps, now: () => at }, opener.owner, opener.linkId);
  await logOpenFromResults(deps.searchLog, opener.owner, opener.agent, link, at);
}
