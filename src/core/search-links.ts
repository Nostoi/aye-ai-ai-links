import { CoreError } from "./errors.js";
import type { LinkSearch, SearchFilters, SearchTrace } from "./search.js";
import { logSearch, type SearchLog } from "./search-log.js";
import type { LinkStore } from "./store.js";
import { tagKey } from "./tags.js";
import type { Link, OwnerId } from "./types.js";

export type SearchLinksInput = {
  query: string;
  tag?: string;
  project?: string;
  savedFrom?: Date;
  savedTo?: Date;
  limit?: number;
};

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

function invalid(message: string): CoreError {
  return new CoreError("invalid_input", message);
}

function checkedDate(name: string, d: Date | undefined): Date | undefined {
  if (d !== undefined && (!(d instanceof Date) || Number.isNaN(d.getTime()))) {
    throw invalid(`${name} is not a valid date. Pass a real date, or leave it out.`);
  }
  return d;
}

export type SearchLinksDeps = {
  store: LinkStore;
  search: LinkSearch;
  searchLog?: SearchLog | undefined;
  now?: (() => Date) | undefined;
};

/**
 * Find the owner's links, best match first. A blank query lists newest first. A search whose
 * trace fires (a word query) is logged under `by`, the calling agent.
 */
export async function searchLinks(
  { store, search, searchLog, now = () => new Date() }: SearchLinksDeps,
  owner: OwnerId,
  input: SearchLinksInput,
  by: string,
): Promise<Link[]> {
  const filters: SearchFilters = {};
  if (input.tag !== undefined) filters.tagKey = tagKey(input.tag);
  if (input.project !== undefined) filters.projectKey = tagKey(input.project);
  const savedFrom = checkedDate("savedFrom", input.savedFrom);
  const savedTo = checkedDate("savedTo", input.savedTo);
  if (savedFrom && savedTo && savedFrom > savedTo) {
    throw invalid("savedFrom is after savedTo. Swap them, or widen the range.");
  }
  if (savedFrom) filters.savedFrom = savedFrom;
  if (savedTo) filters.savedTo = savedTo;
  if (input.limit !== undefined && !Number.isInteger(input.limit)) {
    throw invalid("limit must be a whole number from 1 to 50. Pass an integer, or leave it out.");
  }
  const limit = Math.min(MAX_LIMIT, Math.max(1, input.limit ?? DEFAULT_LIMIT));
  const traces: SearchTrace[] = [];
  const ids = await search.search(owner, input.query, filters, limit, (t) => traces.push(t));
  const links = (await Promise.all(ids.map((id) => store.get(owner, id)))).filter(
    (l): l is Link => l !== null,
  );
  const [trace] = traces;
  if (trace) {
    const { similarity, ...rest } = trace;
    await logSearch(
      searchLog,
      owner,
      by,
      {
        ...rest,
        query: input.query,
        filters,
        results: links.map((l) => ({
          id: l.id,
          urlKey: l.urlKey,
          similarity: similarity[l.id] ?? null,
        })),
      },
      now(),
    );
  }
  return links;
}
