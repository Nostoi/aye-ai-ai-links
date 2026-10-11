import { CoreError } from "./errors.js";
import type { LinkSearch, SearchFilters } from "./search.js";
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

/** Find the owner's links, best match first. A blank query lists newest first. */
export async function searchLinks(
  { store, search }: { store: LinkStore; search: LinkSearch },
  owner: OwnerId,
  input: SearchLinksInput,
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
  const ids = await search.search(owner, input.query, filters, limit);
  const links = await Promise.all(ids.map((id) => store.get(owner, id)));
  return links.filter((l): l is Link => l !== null);
}
