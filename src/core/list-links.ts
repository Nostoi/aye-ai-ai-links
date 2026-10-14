import { type LinkPage, linkPage } from "./link-pages.js";
import type { LinkCount, LinkOrder, LinkSearch } from "./search.js";
import { checkedFilters, checkedLimit } from "./search-links.js";
import type { LinkStore } from "./store.js";
import type { LinkState, OwnerId } from "./types.js";

export type ListLinksInput = {
  order?: LinkOrder;
  tag?: string;
  project?: string;
  state?: LinkState;
  savedFrom?: Date;
  savedTo?: Date;
  cursor?: string;
  limit?: number;
};

/**
 * A page of the owner's links in `order` (newest when left out), with `total`: how many links
 * pass the filters in that order's list, all pages together (for opened, the links with a
 * recorded opening). Filters and limit follow `searchLinks`' rules. The count and the page are
 * separate reads, so a save in between can make them differ by that link.
 */
export async function listLinks(
  deps: { store: LinkStore; search: LinkSearch; count: LinkCount },
  owner: OwnerId,
  input: ListLinksInput,
): Promise<LinkPage & { total: number }> {
  const filters = {
    ...checkedFilters(input),
    ...(input.order === undefined ? {} : { order: input.order }),
    ...(input.state === undefined ? {} : { state: input.state }),
  };
  const limit = checkedLimit(input.limit);
  const page = await linkPage(deps, owner, {
    ...filters,
    limit,
    ...(input.cursor === undefined ? {} : { before: input.cursor }),
  });
  return { ...page, total: await deps.count.count(owner, filters) };
}
