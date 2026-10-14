import { CoreError } from "./errors.js";
import type { LinkStore } from "./store.js";
import { tagKey } from "./tags.js";
import type { OwnerId, Tag } from "./types.js";

const STATUSES = ["active", "done"] as const;
type ProjectStatus = (typeof STATUSES)[number];

/**
 * Mark a project done, or reopen it. A topic has no status, so it is refused. The write only
 * lands while the tag is still a project; if it moved, read again once and apply the rule to
 * what is there now.
 */
export async function setProjectStatus(
  { store }: { store: LinkStore },
  owner: OwnerId,
  input: { name: string; status: ProjectStatus },
): Promise<Tag> {
  const { name, status } = input;
  if (!(STATUSES as readonly unknown[]).includes(status)) {
    throw new CoreError(
      "invalid_input",
      `The status "${String(status)}" is not valid. Use active or done.`,
    );
  }
  const key = tagKey(name);
  for (let attempt = 0; attempt < 2; attempt++) {
    const current = (await store.listTags(owner)).find((t) => t.key === key);
    if (!current) {
      throw new CoreError(
        "not_found",
        `No tag named "${name}" was found. A tag is created by tagging a link.`,
      );
    }
    if (current.kind !== "project") {
      throw new CoreError(
        "invalid_input",
        `The tag "${current.name}" is a topic. Only a project can be done or reopened.`,
      );
    }
    const updated = await store.updateTag(owner, key, { projectStatus: status }, "project");
    if (updated) return updated;
  }
  throw new CoreError(
    "conflict",
    `The tag "${name}" was changed by someone else while this ran. Try again; it may no longer be a project.`,
  );
}
