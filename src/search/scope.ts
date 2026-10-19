import type { SearchFilters } from "../core/search.js";
import type { OwnerId } from "../core/types.js";

/**
 * The owner, live-link, tag, project, date and state conditions every query shares; `ownerCol` is its owner
 * column. Callers must alias `links` as `l`. `order` and `before` are not: only a blank listing
 * orders and pages.
 */
export function scope(ownerCol: string, owner: OwnerId, filters: SearchFilters) {
  const where = [`${ownerCol} = ?`, "l.deleted_at IS NULL"];
  const params: (string | number)[] = [owner];
  const tagFilter = (key: string, project: boolean) => {
    where.push(
      `EXISTS (SELECT 1 FROM link_tags lt JOIN tags t ON t.id = lt.tag_id AND t.owner_id = lt.owner_id
         WHERE lt.link_id = l.id AND lt.owner_id = ${ownerCol} AND t.key = ?${project ? " AND t.kind = 'project'" : ""})`,
    );
    params.push(key);
  };
  if (filters.tagKey !== undefined) tagFilter(filters.tagKey, false);
  if (filters.projectKey !== undefined) tagFilter(filters.projectKey, true);
  if (filters.savedFrom) {
    where.push("l.saved_at >= ?");
    params.push(filters.savedFrom.getTime());
  }
  if (filters.savedTo) {
    where.push("l.saved_at <= ?");
    params.push(filters.savedTo.getTime());
  }
  if (filters.state !== undefined) {
    where.push("l.state = ?");
    params.push(filters.state);
  }
  return { where: where.join(" AND "), params };
}
