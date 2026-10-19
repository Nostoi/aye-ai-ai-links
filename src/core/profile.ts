import { CoreError } from "./errors.js";
import { filingContext } from "./filing-context.js";
import type { ProfileChanges, ProfileStore, ProfileWrite } from "./profile-store.js";
import type { LinkStore } from "./store.js";
import {
  type FocusEntry,
  type Labelled,
  type OwnerId,
  SOURCES,
  type Source,
  type Tag,
} from "./types.js";

/** "Recent focus" is the newest this-many entries. The only definition; #34 imports `recentFocus`. */
export const RECENT_FOCUS = 10;
/** Longer text is refused, never truncated. */
export const MAX_NOTE_CHARS = 1000;
export const MAX_FOCUS_CHARS = 500;
/**
 * How long a removed note can be restored. The only definition: restore refuses older removals,
 * and the owner's next profile write purges them.
 */
export const NOTE_UNDO_WINDOW_MS = 60_000;

const undoCutoff = (now: Date) => new Date(now.getTime() - NOTE_UNDO_WINDOW_MS);

type ProfileDeps = { profile: ProfileStore; now: () => Date };
type Profile = Pick<ProfileWrite, "notes" | "recentFocus">;

const invalid = (message: string) => new CoreError("invalid_input", message);

function cleanText(raw: string, max: number, what: string): string {
  const text = raw.trim();
  if (text === "") {
    throw invalid(
      `A ${what} cannot be blank. Send the text itself, such as "planning a home battery install".`,
    );
  }
  const length = [...text].length;
  if (length > max) {
    throw invalid(
      `A ${what} can be at most ${max} characters; this one is ${length}. Shorten it, or split it into separate entries. Nothing was saved.`,
    );
  }
  return text;
}

function labelled(item: Labelled, max: number, what: string): Labelled {
  if (!(SOURCES as readonly string[]).includes(item.source)) {
    throw invalid(
      `The source "${item.source}" on a ${what} is not valid. Use stated, asked or inferred.`,
    );
  }
  return { text: cleanText(item.text, max, what), source: item.source };
}

export function recentFocus(
  { profile }: { profile: ProfileStore },
  owner: OwnerId,
): Promise<FocusEntry[]> {
  return profile.recentFocus(owner, RECENT_FOCUS);
}

/** The notes and recent focus. `save_link` and `get_profile` both use it. */
export async function profileContext(
  deps: { profile: ProfileStore },
  owner: OwnerId,
): Promise<Profile> {
  const [notes, focus] = await Promise.all([
    deps.profile.listNotes(owner),
    recentFocus(deps, owner),
  ]);
  return { notes, recentFocus: focus };
}

/** Active projects are the same set `save_link` returns, by the same rule. */
export async function getProfile(
  deps: { profile: ProfileStore; store: LinkStore },
  owner: OwnerId,
): Promise<Profile & { activeProjects: Tag[] }> {
  const [context, { activeProjects }] = await Promise.all([
    profileContext(deps, owner),
    filingContext(deps, owner),
  ]);
  return { ...context, activeProjects };
}

const noChanges = (): ProfileChanges => ({
  addNotes: [],
  editNotes: [],
  removeNotes: [],
  addFocus: [],
});

const notFound = (id: string) =>
  new CoreError(
    "not_found",
    `No profile note with id "${id}". Call get_profile to see the note ids. Nothing was changed.`,
  );

const conflict = (id: string) =>
  new CoreError(
    "conflict",
    `Note "${id}" was changed by someone else while this ran. Nothing was changed. Call get_profile to see the notes as they are now, then try again if the change still applies.`,
  );

/** The result comes from the write itself: a read after a committed write could fail and look like a failed write. */
async function write(
  deps: ProfileDeps,
  owner: OwnerId,
  writtenBy: string,
  changes: ProfileChanges,
) {
  const at = deps.now();
  const result = await deps.profile.apply(owner, changes, {
    writtenBy,
    at,
    focusLimit: RECENT_FOCUS,
    purgeBefore: undoCutoff(at),
  });
  if (!result.ok) {
    if ("unknownId" in result) throw notFound(result.unknownId);
    throw conflict(result.conflictId);
  }
  return result;
}

/** A note or focus entry as one write added or removed it. */
export type WrittenEntry = { id: string; text: string; source: Source };

/** `added` is each note and focus entry as stored, with its id; `recentFocus` may not hold them all. */
export async function addProfile(
  deps: ProfileDeps,
  owner: OwnerId,
  writtenBy: string,
  input: { addNotes?: Labelled[]; addFocus?: Labelled[] },
): Promise<ProfileWrite & { added: { notes: WrittenEntry[]; focus: WrittenEntry[] } }> {
  if (!input.addNotes?.length && !input.addFocus?.length) {
    throw invalid(
      "Nothing was given to add: send addNotes or addFocus. To edit or remove notes, use edit_profile. Nothing was changed.",
    );
  }
  const changes = noChanges();
  changes.addNotes = (input.addNotes ?? []).map((n) => labelled(n, MAX_NOTE_CHARS, "profile note"));
  changes.addFocus = (input.addFocus ?? []).map((f) => labelled(f, MAX_FOCUS_CHARS, "focus entry"));
  const { ok: _ok, ...written } = await write(deps, owner, writtenBy, changes);
  const withIds = (entries: Labelled[], ids: string[]) =>
    entries.map((e, i) => ({ id: ids[i] as string, ...e }));
  return {
    ...written,
    added: {
      notes: withIds(changes.addNotes, written.addedNoteIds),
      focus: withIds(changes.addFocus, written.addedFocusIds),
    },
  };
}

/**
 * An edit applies only while the note keeps the source this call read; a removal, only while the
 * note is as read, so a note changed since is a conflict. `removed` is each note as removed.
 */
export async function editProfile(
  deps: ProfileDeps,
  owner: OwnerId,
  writtenBy: string,
  input: { editNotes?: { id: string; text: string; source: Source }[]; removeNotes?: string[] },
): Promise<Profile & { removed: WrittenEntry[] }> {
  if (!input.editNotes?.length && !input.removeNotes?.length) {
    throw invalid(
      "Nothing was given to change: send editNotes or removeNotes. To add notes or focus, use add_profile. Nothing was changed.",
    );
  }
  const edits = (input.editNotes ?? []).map((e) => ({
    id: e.id,
    ...labelled(e, MAX_NOTE_CHARS, "profile note"),
  }));
  const removes = input.removeNotes ?? [];
  const ids = [...edits.map((e) => e.id), ...removes];
  if (new Set(ids).size !== ids.length) {
    throw invalid("Edit or remove each note once per call. An id appears more than once.");
  }
  const read = new Map((await deps.profile.listNotes(owner)).map((n) => [n.id, n]));
  const noteOf = (id: string) => {
    const note = read.get(id);
    if (note === undefined) throw notFound(id);
    return note;
  };
  const changes: ProfileChanges = {
    ...noChanges(),
    editNotes: edits.map((e) => ({ ...e, expectedSource: noteOf(e.id).source })),
    removeNotes: removes.map((id) => ({
      id,
      expectedSource: noteOf(id).source,
      expectedUpdatedAt: noteOf(id).updatedAt,
    })),
  };
  for (const e of changes.editNotes) {
    if (e.source !== "stated" && e.expectedSource === "stated") {
      throw invalid(
        `Note "${e.id}" is stated by the owner, so it can only be edited with source "stated". Leave it as it is and call add_profile with your own note, labelled ${e.source}.`,
      );
    }
  }
  const result = await write(deps, owner, writtenBy, changes);
  const removed = removes.map((id) => {
    const { text, source } = noteOf(id);
    return { id, text, source };
  });
  return { notes: result.notes, recentFocus: result.recentFocus, removed };
}

/** A note the owner adds in their own words is stated. */
export async function addOwnerNote(
  deps: ProfileDeps,
  owner: OwnerId,
  writtenBy: string,
  text: string,
): Promise<void> {
  await addProfile(deps, owner, writtenBy, { addNotes: [{ text, source: "stated" }] });
}

/**
 * The owner's change to note `id`, as it was shown with `updatedAt`. If an agent changed the
 * note since, nothing is written and the answer is `conflict`; a missing or removed note is
 * `not_found`. The store checks `updatedAt` again inside the write, so a change landing after
 * this read is refused too.
 */
async function ownerChange(
  deps: ProfileDeps,
  owner: OwnerId,
  writtenBy: string,
  { id, updatedAt }: { id: string; updatedAt: Date },
  change: (expected: { expectedSource: Source; expectedUpdatedAt: Date }) => ProfileChanges,
): Promise<void> {
  const note = (await deps.profile.listNotes(owner)).find((n) => n.id === id);
  if (!note) throw notFound(id);
  if (note.updatedAt.getTime() !== updatedAt.getTime()) throw conflict(id);
  await write(
    deps,
    owner,
    writtenBy,
    change({ expectedSource: note.source, expectedUpdatedAt: updatedAt }),
  );
}

/**
 * The owner edits a note, or confirms a guess by sending the text shown; either way it becomes
 * stated. Guarded by the `updatedAt` the owner saw (`ownerChange`).
 */
export async function editOwnerNote(
  deps: ProfileDeps,
  owner: OwnerId,
  writtenBy: string,
  input: { id: string; text: string; updatedAt: Date },
): Promise<void> {
  const text = cleanText(input.text, MAX_NOTE_CHARS, "profile note");
  await ownerChange(deps, owner, writtenBy, input, (expected) => ({
    ...noChanges(),
    editNotes: [{ id: input.id, text, source: "stated", ...expected }],
  }));
}

/**
 * The owner removes a note at once. It can be restored for `NOTE_UNDO_WINDOW_MS`. Guarded by
 * the `updatedAt` the owner saw (`ownerChange`).
 */
export async function removeNote(
  deps: ProfileDeps,
  owner: OwnerId,
  writtenBy: string,
  input: { id: string; updatedAt: Date },
): Promise<void> {
  await ownerChange(deps, owner, writtenBy, input, (expected) => ({
    ...noChanges(),
    removeNotes: [{ id: input.id, ...expected }],
  }));
}

/** Undoes a removal made within `NOTE_UNDO_WINDOW_MS`; `not_found` otherwise. */
export async function restoreNote(deps: ProfileDeps, owner: OwnerId, id: string): Promise<void> {
  if (!(await deps.profile.restoreNote(owner, id, undoCutoff(deps.now())))) {
    throw new CoreError(
      "not_found",
      `No note "${id}" was removed in the last ${NOTE_UNDO_WINDOW_MS / 1000} seconds, so there is nothing to restore. Nothing was changed.`,
    );
  }
}
