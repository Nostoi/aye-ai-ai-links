import type { LinkStore } from "./store.js";
import type { OwnerId, Tag } from "./types.js";

/** What an agent needs to file a link: the owner's tags, and the projects not yet done. */
export async function filingContext(
  { store }: { store: LinkStore },
  owner: OwnerId,
): Promise<{ tags: Tag[]; activeProjects: Tag[] }> {
  const tags = await store.listTags(owner);
  const activeProjects = tags.filter((t) => t.kind === "project" && t.projectStatus !== "done");
  return { tags, activeProjects };
}
