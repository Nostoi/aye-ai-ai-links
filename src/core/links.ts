import { CoreError } from "./errors.js";
import type { CopyInfo, SavedCopyReader } from "./saved-copy.js";
import { logOpen, type SearchLog } from "./search-log.js";
import type { SnapshotRunner } from "./snapshot-runner.js";
import {
  EXCERPT_CHARS,
  type PageTextReader,
  readSnapshotText,
  type SnapshotText,
  TEXT_CHARS,
} from "./snapshot-text.js";
import type { LinkStore } from "./store.js";
import { isTagKind, normalizeTags } from "./tags.js";
import {
  type Labelled,
  type Link,
  type LinkPatch,
  type LinkState,
  type OwnerId,
  SOURCES,
  type Source,
  STATES,
  type TagKind,
} from "./types.js";
import { urlKey } from "./url-key.js";

/** How long a save of a new link waits for its page before returning. */
export const SAVE_WAIT_MS = 4_000;

/**
 * `snapshots` fetches a new link's page in the background; without it, saving fetches nothing.
 * `pages` reads a page's text; without it, `snapshotText` is null. `saveWaitMs` defaults to
 * `SAVE_WAIT_MS`.
 */
export type Deps = {
  store: LinkStore;
  now: () => Date;
  snapshots?: Pick<SnapshotRunner, "kick"> | undefined;
  pages?: PageTextReader | undefined;
  searchLog?: SearchLog | undefined;
  saveWaitMs?: number | undefined;
};

type TagInput = { name: string; source: Source; kind?: TagKind }[];

export type SaveLinkInput = {
  url: string;
  title?: string | null;
  summary?: string | null;
  why?: Labelled | null;
  tags?: TagInput;
  savedBy: string;
};

export type UpdateLinkInput = Omit<LinkPatch, "tags" | "lastOpenedAt"> & {
  tags?: TagInput;
  opened?: true;
};

const isSource = (s: string): s is Source => (SOURCES as readonly string[]).includes(s);
const isState = (s: string): s is LinkState => (STATES as readonly string[]).includes(s);

function invalid(message: string): CoreError {
  return new CoreError("invalid_input", message);
}

function checkSources(why: Labelled | null | undefined, tags: TagInput | undefined): void {
  if (why && !isSource(why.source)) {
    throw invalid(`The why source "${why.source}" is not valid. Use stated, asked or inferred.`);
  }
  for (const t of tags ?? []) {
    if (!isSource(t.source)) {
      throw invalid(
        `The source "${t.source}" on tag "${t.name}" is not valid. Use stated, asked or inferred.`,
      );
    }
    if (t.kind !== undefined && !isTagKind(t.kind)) {
      throw invalid(`The kind "${t.kind}" on tag "${t.name}" is not valid. Use topic or project.`);
    }
  }
}

/** Trim the why text; empty text means the why is missing. */
function cleanWhy(why: Labelled | null | undefined): Labelled | null {
  const text = why?.text.trim();
  return why && text ? { text, source: why.source } : null;
}

/** The longest title kept, in characters (code points). */
export const TITLE_MAX = 200;

/**
 * The one title rule, for agents and the web edit: trimmed, and blank means no title (the card
 * shows the URL). Longer than TITLE_MAX is refused. Only a title being written is checked.
 */
export function normalizeTitle(title: string | null): string | null {
  if (title === null) return null;
  const trimmed = title.trim();
  if (!titleFits(trimmed)) {
    throw invalid(`A title can be at most ${TITLE_MAX} characters.`);
  }
  return trimmed === "" ? null : trimmed;
}

export const titleFits = (title: string) => [...title.trim()].length <= TITLE_MAX;

/** Waits for `job`, or `ms`, whichever ends first, and leaves no timer behind. */
async function settledWithin(job: Promise<void>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeUp = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  try {
    await Promise.race([job, timeUp]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Saves a link, or returns the one already saved. Only a new link's page is fetched; the save
 * waits up to `saveWaitMs` for it, so the result can show the page. A repeat save never waits.
 * `snapshotText` is the page's opening text, up to `EXCERPT_CHARS`. `whyFilled`: this repeat save
 * filled the missing why, and the link now holds that why. Two identical repeat saves racing can
 * both say so. With `{ receipt: true }` (the in-app AI), a fill also writes a receipt for Undo, and
 * `whyEditId` is its id, or null when this call wrote none. Without it, there is no `whyEditId`.
 */
export async function saveLink(
  deps: Deps,
  owner: OwnerId,
  input: SaveLinkInput,
  options: { receipt: true },
): Promise<SaveLinkResult & { whyEditId: string | null }>;
export async function saveLink(
  deps: Deps,
  owner: OwnerId,
  input: SaveLinkInput,
  options?: { receipt?: undefined },
): Promise<SaveLinkResult>;
export async function saveLink(
  { store, now, snapshots, pages, saveWaitMs = SAVE_WAIT_MS }: Deps,
  owner: OwnerId,
  input: SaveLinkInput,
  options: { receipt?: true } = {},
): Promise<SaveLinkResult & { whyEditId?: string | null }> {
  const key = urlKey(input.url);
  checkSources(input.why, input.tags);
  const tags = normalizeTags(input.tags ?? []);
  const title = normalizeTitle(input.title ?? null);
  const why = cleanWhy(input.why);
  const result = await store.insertIfAbsent(owner, {
    url: input.url.trim(),
    urlKey: key,
    title,
    summary: input.summary ?? null,
    why,
    tags,
    savedAt: now(),
    savedBy: input.savedBy,
    lastOpenedAt: null,
    lastSurfacedAt: null,
    snoozedUntil: null,
    state: "active",
  });
  let link = result.link;
  let whyFilled = false;
  let whyEditId: string | null = null;
  if (result.created) {
    // The save has committed; `kick` never rejects, so the background fetch cannot fail it.
    const job = snapshots?.kick(owner, link.id);
    if (job) await settledWithin(job, saveWaitMs);
    // Read again for the page, and for any edit made while waiting.
    link = (await store.get(owner, link.id)) ?? link;
  } else if (why && !link.why) {
    const filled = options.receipt
      ? await store.fillWhyWithReceipt(owner, link.id, why, now())
      : await store
          .fillWhyIfMissing(owner, link.id, why)
          .then((l) => l && { link: l, editId: null });
    const after = filled?.link;
    whyFilled = after?.why?.text === why.text && after.why.source === why.source;
    whyEditId = filled?.editId ?? null;
    link = after ?? link;
  }
  const saved = {
    link,
    created: result.created,
    snapshotText: await readSnapshotText(pages, owner, link, EXCERPT_CHARS),
    whyFilled,
  };
  return options.receipt ? { ...saved, whyEditId } : saved;
}

type SaveLinkResult = {
  link: Link;
  created: boolean;
  snapshotText: SnapshotText | null;
  whyFilled: boolean;
};

export async function getLink({ store }: Deps, owner: OwnerId, id: string): Promise<Link> {
  const link = await store.get(owner, id);
  if (!link) throw notFound(id);
  return link;
}

/**
 * The link with its page text, up to `TEXT_CHARS`. `by` is the calling agent; with `searchLog`,
 * the open is paired with that agent's latest search.
 */
export async function getLinkWithText(
  deps: Deps & { savedCopies: Pick<SavedCopyReader, "copyInfo"> },
  owner: OwnerId,
  id: string,
  by: string,
): Promise<{ link: Link; snapshotText: SnapshotText | null; savedCopy: CopyInfo | null }> {
  const link = await getLink(deps, owner, id);
  await logOpen(deps.searchLog, owner, by, link, deps.now());
  const snapshotText = await readSnapshotText(deps.pages, owner, link, TEXT_CHARS);
  const savedCopy = (await deps.savedCopies.copyInfo(owner, [link.id])).get(link.id) ?? null;
  return { link, snapshotText, savedCopy };
}

/** Checks the input and builds the patch; throws before anything is written. */
function buildPatch(now: () => Date, input: UpdateLinkInput): LinkPatch {
  const { tags, why, title, summary, state, snoozedUntil, opened } = input;
  if (state !== undefined && !isState(state)) {
    throw invalid(`The state "${state}" is not valid. Use active or archived.`);
  }
  if (
    snoozedUntil !== undefined &&
    snoozedUntil !== null &&
    (!(snoozedUntil instanceof Date) || Number.isNaN(snoozedUntil.getTime()))
  ) {
    throw invalid("snoozedUntil is not a valid date. Pass a date, or null to clear the snooze.");
  }
  checkSources(why, tags);
  const patch: LinkPatch = {};
  if (title !== undefined) patch.title = normalizeTitle(title);
  if (summary !== undefined) patch.summary = summary;
  if (state !== undefined) patch.state = state;
  if (snoozedUntil !== undefined) patch.snoozedUntil = snoozedUntil;
  if (opened === true) patch.lastOpenedAt = now();
  if (tags !== undefined) patch.tags = normalizeTags(tags);
  if (why !== undefined) patch.why = cleanWhy(why);
  return patch;
}

export async function updateLink(
  { store, now }: Deps,
  owner: OwnerId,
  id: string,
  input: UpdateLinkInput,
): Promise<Link> {
  const link = await store.update(owner, id, buildPatch(now, input));
  if (!link) throw notFound(id);
  return link;
}

/** `updateLink` for the in-app AI: the store also records what the edit replaced, and `editId` is its id for Undo (null when no covered field changed). */
export async function updateLinkWithReceipt(
  { store, now }: Deps,
  owner: OwnerId,
  id: string,
  input: UpdateLinkInput,
): Promise<{ link: Link; editId: string | null }> {
  const result = await store.updateWithReceipt(owner, id, buildPatch(now, input), now());
  if (!result) throw notFound(id);
  return result;
}

/**
 * The owner opened the link: records when, and only that. It is not a nudge, so it never marks
 * the link surfaced, and it is not a search's open, so it is never logged.
 */
export async function recordOpening(deps: Deps, owner: OwnerId, id: string): Promise<Link> {
  return updateLink(deps, owner, id, { opened: true });
}

export function notFound(id: string): CoreError {
  return new CoreError(
    "not_found",
    `No link with id "${id}" was found. Use search_links to find the right id.`,
  );
}
