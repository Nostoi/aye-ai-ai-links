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
function apply(deps: ProfileDeps, owner: OwnerId, writtenBy: string, changes: ProfileChanges) {
  return deps.profile.apply(owner, changes, {
    writtenBy,
    at: deps.now(),
    focusLimit: RECENT_FOCUS,
  });
}

async function write(
  deps: ProfileDeps,
  owner: OwnerId,
  writtenBy: string,
  changes: ProfileChanges,
) {
  const result = await apply(deps, owner, writtenBy, changes);
  if (!result.ok) {
    if ("unknownId" in result) throw notFound(result.unknownId);
    throw conflict(result.conflictId);
  }
  return result;
}

export async function addProfile(
  deps: ProfileDeps,
  owner: OwnerId,
  writtenBy: string,
  input: { addNotes?: Labelled[]; addFocus?: Labelled[] },
): Promise<ProfileWrite> {
  const changes = noChanges();
  changes.addNotes = (input.addNotes ?? []).map((n) => labelled(n, MAX_NOTE_CHARS, "profile note"));
  changes.addFocus = (input.addFocus ?? []).map((f) => labelled(f, MAX_FOCUS_CHARS, "focus entry"));
  const { ok: _ok, ...written } = await write(deps, owner, writtenBy, changes);
  return written;
}

export async function editProfile(
  deps: ProfileDeps,
  owner: OwnerId,
  writtenBy: string,
  input: { editNotes?: { id: string; text: string; source: Source }[]; removeNotes?: string[] },
): Promise<Profile> {
  const edits = (input.editNotes ?? []).map((e) => ({
    id: e.id,
    ...labelled(e, MAX_NOTE_CHARS, "profile note"),
  }));
  const removes = input.removeNotes ?? [];
  const ids = [...edits.map((e) => e.id), ...removes];
  if (new Set(ids).size !== ids.length) {
    throw invalid("Edit or remove each note once per call. An id appears more than once.");
  }
  for (let attempt = 0; ; attempt++) {
    const read = new Map((await deps.profile.listNotes(owner)).map((n) => [n.id, n.source]));
    const sourceOf = (id: string): Source => {
      const source = read.get(id);
      if (source === undefined) throw notFound(id);
      return source;
    };
    const changes: ProfileChanges = {
      ...noChanges(),
      editNotes: edits.map((e) => ({ ...e, expectedSource: sourceOf(e.id) })),
      removeNotes: removes.map((id) => ({ id, expectedSource: sourceOf(id) })),
    };
    for (const e of changes.editNotes) {
      if (e.source !== "stated" && e.expectedSource === "stated") {
        throw invalid(
          `Note "${e.id}" is stated by the owner, so it can only be edited with source "stated". Leave it as it is and call add_profile with your own note, labelled ${e.source}.`,
        );
      }
    }
    const result = await apply(deps, owner, writtenBy, changes);
    if (result.ok) return { notes: result.notes, recentFocus: result.recentFocus };
    if ("unknownId" in result) throw notFound(result.unknownId);
    if (attempt > 0 || removes.includes(result.conflictId)) throw conflict(result.conflictId);
  }
}
