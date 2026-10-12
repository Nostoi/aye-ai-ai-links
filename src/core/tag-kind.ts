import { CoreError } from "./errors.js";
import type { LinkStore } from "./store.js";
import { isTagKind, tagKey } from "./tags.js";
import type { OwnerId, Tag, TagKind } from "./types.js";

/**
 * Change an existing tag between topic and project. Any change of kind clears
 * the project status; asking for the kind the tag already has writes nothing.
 * The write only lands while the kind is still the one that was read; if it
 * moved, read again once and apply the rule to what is there now.
 */
export async function changeTagKind(
  { store }: { store: LinkStore },
  owner: OwnerId,
  input: { name: string; kind: TagKind },
): Promise<Tag> {
  const { name, kind } = input;
  if (!isTagKind(kind)) {
    throw new CoreError("invalid_input", `The kind "${kind}" is not valid. Use topic or project.`);
  }
  const key = tagKey(name);
  for (let attempt = 0; attempt < 2; attempt++) {
    const current = (await store.listTags(owner)).find((t) => t.key === key);
    if (!current) {
      throw new CoreError(
        "not_found",
        `No tag named "${name}" was found. Ask the owner for the exact name; the tags on links from search_links show the names in use. A tag is created by tagging a link.`,
      );
    }
    if (current.kind === kind) return current;
    const updated = await store.updateTag(owner, key, { kind, projectStatus: null }, current.kind);
    if (updated) return updated;
  }
  throw new CoreError(
    "conflict",
    `The tag "${name}" was changed by someone else while this ran. Call update_tag again if it should still change; it returns the tag as it is now.`,
  );
}
