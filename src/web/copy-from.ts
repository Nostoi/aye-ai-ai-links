import { findSpaceTag } from "../core/spaces.js";
import type { Tag } from "../core/types.js";
import { allHref } from "./all-page.js";
import type { Back } from "./copy-page.js";
import { OUT_OF_LISTS } from "./done-link.js";
import { searchHref } from "./pages.js";
import { spaceHref } from "./space-page.js";

const ALL: Back = { label: "All links", href: allHref("newest") };

/** The tag the owner has, or null: a space is only named when it is in their catalog. */
function ownedTag(catalog: Tag[], name: string | null): Tag | null {
  if (name === null) return null;
  try {
    return findSpaceTag(catalog, name);
  } catch {
    return null;
  }
}

const BASE = "http://site.invalid";
const LISTS_BY_TAG = new Set(["/spaces", "/spaces/done", "/search"]);

/** The URL of a value that is a path on this site, else null: another origin (`//host`, a scheme, `/\host`) is refused. */
function parse(from: string | undefined): URL | null {
  if (from === undefined || !from.startsWith("/")) return null;
  try {
    const url = new URL(from, BASE);
    return url.origin === BASE ? url : null;
  } catch {
    return null;
  }
}

/** `from` with the tag of a space or search address replaced by the live key an old one reaches; anything else comes back as it was. */
export async function liveFrom(
  from: string,
  addressOf: (name: string) => Promise<string | null>,
): Promise<string> {
  const url = parse(from);
  const name = url?.searchParams.get("tag");
  if (!url || !name || !LISTS_BY_TAG.has(url.pathname)) return from;
  const current = await addressOf(name).catch(() => null);
  if (current === null) return from;
  url.searchParams.set("tag", current);
  return `${url.pathname}${url.search}`;
}

/**
 * Where the saved-copy page's Back goes, from the `from` its link carried: the list page the
 * owner came from. Only a path on this site that is one of the list pages counts. The address is
 * rebuilt from what picks the list (the space, the search words, keep mode) and never echoed, so
 * no other value can reach the page; order and page position are dropped, so Back lands on the
 * list's first page. A space or search tag counts only when it is in the owner's `catalog`.
 * Anything else, or nothing, goes to All links.
 */
export function backTarget(from: string | undefined, catalog: Tag[]): Back {
  const url = parse(from);
  if (url === null) return ALL;
  const query = url.searchParams;
  switch (url.pathname) {
    case "/":
      return { label: "Home", href: "/" };
    case "/all":
      return ALL;
    case "/all/done":
      return { label: OUT_OF_LISTS, href: allHref("newest", { done: true }) };
    case "/spaces":
    case "/spaces/done": {
      const tag = ownedTag(catalog, query.get("tag"));
      return tag
        ? { label: tag.name, href: spaceHref(tag.key, { done: url.pathname === "/spaces/done" }) }
        : ALL;
    }
    case "/search": {
      const tag = ownedTag(catalog, query.get("tag"));
      return {
        label: "your search",
        href: searchHref(query.get("q") ?? "", {
          ...(tag ? { tag: tag.key } : {}),
          keep: query.get("keep") === "1",
        }),
      };
    }
    default:
      return ALL;
  }
}
