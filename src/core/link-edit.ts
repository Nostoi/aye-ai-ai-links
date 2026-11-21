import { CoreError } from "./errors.js";
import { checkImage } from "./image-type.js";
import { checkIntent, keptToolStays } from "./intent.js";
import type { LinkEdit, LinkEditStore } from "./link-edit-store.js";
import { cleanWhy, isSource, normalizeTitle, notFound } from "./links.js";
import { normalizeTags } from "./tags.js";
import type { Intent, OwnerId, Source } from "./types.js";

export type EditDeps = { edits: LinkEditStore; now: () => Date };

/**
 * What the owner asked to change: a title (null or blank removes it), the picture's bytes or
 * "page", and the link's tags. `tags.names` is the final list in order; `tags.seen` is the
 * ordered key and source of each tag the owner's dialog opened with. `intent` is the owner's
 * choice, with the intent and source the dialog opened with in `seen` (a null source: nobody
 * said). `why` is the owner's text (blank removes it), with the why the dialog opened with in
 * `seen` (null: none).
 */
export type EditInput = {
  title?: string | null;
  picture?: Uint8Array | "page";
  tags?: { names: string[]; seen: { key: string; source: string }[] };
  intent?: { value: string; seen: { intent: string; source: string | null } };
  why?: { text: string; seen: { text: string; source: string } | null };
};

export const BAD_PICTURE = "That picture can't be used. Try a PNG, JPEG, GIF or WebP under 2 MB.";
export const INTENT_CONFLICT =
  "This link's intent changed since you opened it. Reload the page and edit again.";
export const WHY_CONFLICT =
  "This link's why changed since you opened it. Reload the page and edit again.";
export const UNDO_CONFLICT = "This link changed since, so nothing was undone.";
export const TAGS_CONFLICT =
  "This link's tags changed since you opened it. Reload the page and edit again.";

/**
 * The owner's edit of a link's title, picture and tags. The title goes through the one title
 * rule, the picture through the one image check and the names through the one tag rule, all
 * before anything is written. "page" removes the owner's picture, so the page's shows. A tag
 * the dialog opened with keeps its source, so removing one and adding it back changes nothing;
 * any other name is stated. The store applies the edit in one transaction, and only while the
 * link still holds the tags the dialog opened with (otherwise a conflict, and nothing is
 * written). Returns the edit's id for its Undo, or null when nothing changed.
 */
export async function editLink(
  deps: EditDeps,
  owner: OwnerId,
  id: string,
  input: EditInput,
): Promise<string | null> {
  const edit: LinkEdit = {};
  if (input.title !== undefined) edit.title = normalizeTitle(input.title);
  if (input.picture === "page") edit.picture = "page";
  else if (input.picture !== undefined) {
    const check = checkImage(input.picture);
    if (!check.ok) throw new CoreError("invalid_input", BAD_PICTURE);
    edit.picture = { set: { contentType: check.type, bytes: input.picture } };
  }
  if (input.tags) edit.tags = tagEdit(input.tags);
  if (input.intent) edit.intent = intentEdit(input.intent);
  if (input.why) edit.why = whyEdit(input.why);
  const result = await deps.edits.applyEdit(owner, id, edit, deps.now());
  if (!result) throw notFound(id);
  if (result === "conflict") throw new CoreError("conflict", TAGS_CONFLICT);
  if (result === "intent_conflict") throw new CoreError("conflict", INTENT_CONFLICT);
  if (result === "why_conflict") throw new CoreError("conflict", WHY_CONFLICT);
  if (result === "kept_tool") throw keptToolStays();
  return result.editId;
}

/** The owner's choice is stated. What the dialog opened with is checked as the store compares it. */
function intentEdit({
  value,
  seen,
}: NonNullable<EditInput["intent"]>): NonNullable<LinkEdit["intent"]> {
  const set = checkIntent(value, "stated");
  const opened = seen.source === null ? undefined : checkIntent(seen.intent, seen.source);
  if (seen.source === null && seen.intent !== "explore") {
    throw new CoreError("invalid_input", "A link with no intent source is To explore.");
  }
  return {
    expected: opened ?? { intent: "explore", intentSource: null },
    set: set as { intent: Intent; intentSource: Source },
  };
}

/** The owner's words are stated, trimmed, with every line break as LF (a form posts CRLF); blank removes the why. What the dialog opened with is checked as the store compares it. */
function whyEdit({ text, seen }: NonNullable<EditInput["why"]>): NonNullable<LinkEdit["why"]> {
  if (seen && !isSource(seen.source)) {
    throw new CoreError("invalid_input", `A why's source is "${seen.source}", which is not one.`);
  }
  return {
    expected: seen && { text: seen.text, source: seen.source as Source },
    set: cleanWhy({ text, source: "stated" }),
  };
}

function tagEdit({ names, seen }: NonNullable<EditInput["tags"]>): NonNullable<LinkEdit["tags"]> {
  const sources = new Map<string, Source>();
  for (const t of seen) {
    if (!isSource(t.source)) {
      throw new CoreError("invalid_input", `A tag's source is "${t.source}", which is not one.`);
    }
    sources.set(t.key, t.source);
  }
  const set = normalizeTags(names.map((name) => ({ name, source: "stated" as const }))).map((t) => {
    const source = sources.get(t.key);
    return source ? { ...t, source } : t;
  });
  return { expected: seen.map((t) => ({ key: t.key, source: t.source as Source })), set };
}

/**
 * The Undo of `editLink`: it puts back what the edit replaced only while the edit is the link's
 * latest and the link still holds what it wrote. Otherwise it is a conflict, and nothing changes.
 */
export async function undoEdit(
  deps: Pick<EditDeps, "edits">,
  owner: OwnerId,
  id: string,
  editId: string,
): Promise<void> {
  const outcome = await deps.edits.undoEdit(owner, id, editId);
  if (outcome === null) throw notFound(id);
  if (outcome === "conflict") throw new CoreError("conflict", UNDO_CONFLICT);
}
