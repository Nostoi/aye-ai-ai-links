import { type Context, Hono } from "hono";
import { getCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import {
  type PageContext,
  runChatTurn,
  SERVER_FAULT,
  type TextTurn,
  type TurnResult,
  takeTurn,
} from "../ai/chat-turn.js";
import type { ChatModel } from "../ai/model.js";
import { openToolSession, type ToolSession } from "../ai/tool-session.js";
import { AgentKeyError } from "../auth/agent-keys.js";
import type { WithAuthLock } from "../auth/auth-lock.js";
import type { Auth } from "../auth/better-auth.js";
import type { ConsentDetails } from "../auth/consent.js";
import { AUTH_BODY_LIMIT, BodyTooLarge, readCapped } from "../auth/http.js";
import { loginRedirect, returnAfterLogin, SAVE_PATH } from "../auth/login-return.js";
import { OAUTH_ERROR_PATH, oauthErrorMessage } from "../auth/oauth-error.js";
import { inAppCaller } from "../auth/session.js";
import { createCopyReader, type ReadGate } from "../core/copy-reading.js";
import { removeSavedCopy, restoreSavedCopy } from "../core/copy-removal.js";
import { readCopyNotice } from "../core/copy-usage.js";
import { CoreError, type CoreErrorCode } from "../core/errors.js";
import type { ExportBuilds } from "../core/export-builds.js";
import { exportFilename, exportManifest } from "../core/export-format.js";
import type { LinkImageReader } from "../core/image-store.js";
import { MAX_IMAGE_BYTES } from "../core/image-type.js";
import { type LinkCheckDeps, restoreCheck, stillWorks } from "../core/link-check.js";
import { CHECK_RESULTS, type LinkCheck } from "../core/link-check-store.js";
import { editLink, undoEdit } from "../core/link-edit.js";
import type { LinkEditStore } from "../core/link-edit-store.js";
import { checkedOrder, linkPage } from "../core/link-pages.js";
import { deleteLink, restoreLink } from "../core/link-removal.js";
import { lineSpace, linkSpace } from "../core/link-space.js";
import { getLink, recordOpening } from "../core/links.js";
import {
  addOwnerNote,
  editOwnerNote,
  profileContext,
  removeNote,
  restoreNote,
} from "../core/profile.js";
import type { ProfileStore } from "../core/profile-store.js";
import { setProjectStatus } from "../core/project-status.js";
import { type SavedPage, savePage } from "../core/save-page.js";
import type { SavedCopyReader, SavedCopyRemover, SavedCopyUsage } from "../core/saved-copy.js";
import type { LinkOrder } from "../core/search.js";
import { type SearchLinksDeps, searchLinks } from "../core/search-links.js";
import { findSpaceTag, homeSpaces, openSpace } from "../core/spaces.js";
import { getStats, parseWindow, statsReading } from "../core/stats.js";
import type { StatsReadingStore } from "../core/stats-reading-store.js";
import type { StatsStore } from "../core/stats-store.js";
import type { LinkRemover } from "../core/store.js";
import {
  deleteTag,
  listTagsWithCounts,
  mergeTags,
  renameTag,
  tagAddress,
  undoTagChange,
} from "../core/tag-edit.js";
import type { TagEditStore } from "../core/tag-edit-store.js";
import { changeTagKind } from "../core/tag-kind.js";
import { type SpaceColor, setTagColor, setTagPinned } from "../core/tag-space.js";
import {
  dismissTagPair,
  type NameVectors,
  suggestTagMerges,
  type TagMergeSuggestion,
  undismissTagPair,
} from "../core/tag-suggest.js";
import type { TagSuggestStore } from "../core/tag-suggest-store.js";
import { tagKey } from "../core/tags.js";
import { currentFocus, keepInTidy, TIDY_SESSION, tidyQueue, tidyReady } from "../core/tidy-up.js";
import type { ToolRecord, WaitDays } from "../core/tool-store.js";
import {
  answerSuggestion,
  handyOf,
  keepHandy,
  linkViews,
  listShelf,
  listSuggestions,
  notHandy,
  restoreTool,
  stillUsing,
  type ToolChange,
} from "../core/tools.js";
import {
  type LinkState,
  type OwnerId,
  SOURCES,
  type Source,
  STATES,
  type Tag,
  type TagKind,
  TOOL_STATUSES,
  type ToolStatus,
} from "../core/types.js";
import {
  archiveLink,
  bringBackLink,
  markOpened,
  putAwayLink,
  type StateChange,
  snoozeLink,
  tellWhy,
  undoStateChange,
  unsnoozeLink,
  type WorthDeps,
  worthALook,
} from "../core/worth-a-look.js";
import type { McpDeps, TrackCall } from "../mcp/server.js";
import { type KeyInfo, KeyStoreError } from "../store/key-store.js";
import { chatAnswer } from "./ai-answer.js";
import { askCard } from "./ai-card.js";
import { ALL_RESTART, allHref, allPage } from "./all-page.js";
import type { Ask } from "./ask-panel.js";
import { bookmarkletCode } from "./bookmarklet.js";
import { type ConnectionRow, connectionsPage } from "./connections-page.js";
import { backTarget, liveFrom } from "./copy-from.js";
import { COPY_HEADERS, copyNotFoundPage, copyPage } from "./copy-page.js";
import { displayTitle } from "./display-title.js";
import { shownTags } from "./edit-link.js";
import { handyShelf } from "./handy-shelf.js";
import { homePage } from "./home-page.js";
import { initialsText } from "./initials.js";
import { VIEW_COOKIE, viewOf } from "./link-rows.js";
import { savedOn } from "./page.js";
import { consentExpiredPage, consentPage, loginPage, oauthErrorPage, searchPage } from "./pages.js";
import { profilePage } from "./profile-page.js";
import { requireSession, type SessionEnv } from "./require-session.js";
import { saveForm } from "./save-form.js";
import { olderInvalidPage } from "./show-older.js";
import { SPACE_RESTART, spaceHref, spaceMissingPage, spacePage } from "./space-page.js";
import { spacesSection } from "./spaces-section.js";
import { tagsPage } from "./tags-page.js";
import { tidyPage } from "./tidy-page.js";

/** How many links a space page or All links shows at a time. */
const LINK_PAGE = 24;

/** Pages show one person's data, so no browser or proxy may keep a copy. */
const NO_STORE = { "Cache-Control": "no-store" };
/** The Save page's headers: uncached, and never framed, so no site can lay a fake Save button over it. */
const SAVE_PAGE_HEADERS = { ...NO_STORE, "Content-Security-Policy": "frame-ancestors 'none'" };

/** A link's stored preview image. The id must be digits; anything else is not this route. */
export const IMAGE_ROUTE = "/images/:id{[0-9]+}";

/** The page for reading a link's saved copy. */
export const COPY_ROUTE = "/links/:id{[0-9]+}/copy";

/** A picture of a link's saved copy: `n` is one or two digits, as the copy numbers them. */
export const COPY_IMAGE_ROUTE = "/links/:id{[0-9]+}/copy/images/:n{[0-9]{1,2}}";

/** The links-only export download (#130). */
export const EXPORT_JSON_ROUTE = "/export.json";

/** The whole export (#130): the zip a build prepared. */
export const EXPORT_ZIP_ROUTE = "/export.zip";

/** Starts building the owner's zip; takes no body. */
export const EXPORT_PREPARE_ROUTE = "/export/prepare";

/**
 * Headers for a stored image. It is served as an image only, never sniffed or run as a document.
 * The one exception to `NO_STORE` (owner ruling on #94): a URL carrying the image's current
 * version is cached privately for a year, since a new image gets a new version, and the sign-out
 * response sends `Clear-Site-Data: "cache"` (`src/auth/http.ts`).
 */
const imageHeaders = (contentType: string, cached: boolean) => ({
  "Content-Type": contentType,
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "default-src 'none'; sandbox",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Content-Disposition": "inline",
  "Cache-Control": cached ? "private, max-age=31536000, immutable" : "no-store",
});

type Check<T> = (value: unknown) => value is T;
const isString: Check<string> = (value) => typeof value === "string";
const isStringOrNull: Check<string | null> = (value) => value === null || typeof value === "string";
const isBoolean: Check<boolean> = (value) => typeof value === "boolean";
const isSafeInteger = (value: unknown): value is number => Number.isSafeInteger(value);
const isId = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;

/** A link id as the page sends it: digits, as the store issues them. */
const isLinkId = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9]{1,20}$/.test(value);
const isDate = (value: unknown): value is string =>
  typeof value === "string" && !Number.isNaN(Date.parse(value));
const isDateOrNull = (value: unknown): value is string | null => value === null || isDate(value);

/** The object a shape of member checks accepts. */
type Shaped<S extends Record<string, Check<unknown>>> = {
  [K in keyof S]: S[K] extends Check<infer T> ? T : never;
};

/** The request's body parsed as JSON under `limit` (undefined when it isn't JSON), or the 413 answer. */
async function readJson(c: Context, limit: number): Promise<{ value: unknown } | Response> {
  let raw: Uint8Array | null;
  try {
    raw = await readCapped(c.req.raw, limit);
  } catch (error) {
    if (!(error instanceof BodyTooLarge)) throw error;
    return c.json({ code: "PAYLOAD_TOO_LARGE", message: "Request body too large." }, 413);
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(raw ?? new Uint8Array()));
  } catch {}
  return { value };
}

/**
 * Takes a JSON body under the auth body cap, so any client id that can connect fits, and sets
 * `body` to it when it is an object whose members pass each check in `shape`. Other members are
 * ignored. This checks types only; the rules are core's.
 */
const jsonBody = <S extends Record<string, Check<unknown>>>(shape: S) =>
  createMiddleware<{ Variables: { body: Shaped<S> } }>(async (c, next) => {
    const read = await readJson(c, AUTH_BODY_LIMIT);
    if (read instanceof Response) return read;
    const { value } = read;
    const fits =
      typeof value === "object" &&
      value !== null &&
      Object.entries(shape).every(([name, check]) =>
        check((value as Record<string, unknown>)[name]),
      );
    if (!fits) {
      const names = Object.keys(shape).join(" and ");
      return c.json({ code: "BAD_REQUEST", message: `Send a JSON body with ${names}.` }, 400);
    }
    c.set("body", value as Shaped<S>);
    await next();
  });

/** The chat's cap: room for a full history of long turns. */
export const CHAT_BODY_LIMIT = 512 * 1024;

/**
 * Takes a chat turn, a JSON body under `CHAT_BODY_LIMIT`, and sets `turn` to the history and
 * text `takeTurn` accepts. Other members, such as an owner or a writer's name, are ignored.
 */
const chatBody = createMiddleware<{
  Variables: { turn: { history: TextTurn[]; text: string; page?: PageContext } };
}>(async (c, next) => {
  const read = await readJson(c, CHAT_BODY_LIMIT);
  if (read instanceof Response) return read;
  const value = read.value as { history?: unknown; text?: unknown; page?: unknown } | null;
  const turn =
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? takeTurn({ history: value.history, text: value.text, page: value.page })
      : null;
  if (!turn) {
    const message = "Send a JSON body with history and text, within the chat's limits.";
    return c.json({ code: "BAD_REQUEST", message }, 400);
  }
  c.set("turn", turn);
  await next();
});

/** The edit form's cap: the largest picture core keeps, plus the auth cap for the other fields. */
const EDIT_BODY_LIMIT = MAX_IMAGE_BYTES + AUTH_BODY_LIMIT;

/** Where a list shows the card: the space it is within, and whether it is that space's own page (`lineSpace`). */
type View = { within?: string; own?: boolean };

/** The edit form as the door read it: only the fields the page sent. */
type EditForm = View & {
  id: string;
  title?: string;
  picture?: Uint8Array | "page";
  tags?: { names: string[]; seen: { key: string; source: string }[] };
};

const isText = (value: unknown): value is string => typeof value === "string";

/**
 * The `tags` and `seen` form fields, JSON, which are sent together or not at all: `undefined` when
 * neither was sent, `null` when they are not that shape (an array of texts, and an array of
 * `{ key, source }` texts).
 */
function takeTags(tags: unknown, seen: unknown): EditForm["tags"] | null | undefined {
  if (tags === null && seen === null) return undefined;
  if (typeof tags !== "string" || typeof seen !== "string") return null;
  let names: unknown;
  let marks: unknown;
  try {
    names = JSON.parse(tags);
    marks = JSON.parse(seen);
  } catch {
    return null;
  }
  if (!Array.isArray(names) || !names.every(isText)) return null;
  const fits = (m: unknown): m is { key: string; source: string } =>
    typeof m === "object" &&
    m !== null &&
    isText((m as { key?: unknown }).key) &&
    isText((m as { source?: unknown }).source);
  if (!Array.isArray(marks) || !marks.every(fits)) return null;
  return { names, seen: marks.map(({ key, source }) => ({ key, source })) };
}

/** An optional JSON member: absent, or passing `check`. */
const optional =
  <T>(check: Check<T>): Check<T | undefined> =>
  (value): value is T | undefined =>
    value === undefined || check(value);
const isOne: Check<"1"> = (value) => value === "1";

/**
 * Takes the edit form, a `multipart/form-data` body under `EDIT_BODY_LIMIT`, and sets `edit`
 * when `id` is a link id, `title` (if sent) is text and `picture` (if sent) is a file or
 * `page`. This checks shapes only; the title rule and the image check are core's.
 */
const editForm = createMiddleware<{ Variables: { edit: EditForm } }>(async (c, next) => {
  let raw: Uint8Array | null;
  try {
    raw = await readCapped(c.req.raw, EDIT_BODY_LIMIT);
  } catch (error) {
    if (!(error instanceof BodyTooLarge)) throw error;
    return c.json({ code: "PAYLOAD_TOO_LARGE", message: "Request body too large." }, 413);
  }
  const bad = () =>
    c.json(
      { code: "BAD_REQUEST", message: "Send a form with id, and title, picture or tags." },
      400,
    );
  const type = c.req.header("content-type") ?? "";
  if (!/^multipart\/form-data/i.test(type)) return bad();
  let form: FormData;
  try {
    const body = new Uint8Array(raw ?? []);
    form = await new Response(body, { headers: { "content-type": type } }).formData();
  } catch {
    return bad();
  }
  const id = form.get("id");
  const title = form.get("title");
  const picture = form.get("picture");
  const within = form.get("within");
  const own = form.get("own");
  if (!isLinkId(id) || (title !== null && typeof title !== "string")) return bad();
  if (picture !== null && picture !== "page" && !(picture instanceof Blob)) return bad();
  if ((within !== null && typeof within !== "string") || (own !== null && own !== "1")) {
    return bad();
  }
  const tags = takeTags(form.get("tags"), form.get("seen"));
  if (tags === null) return bad();
  const edit: EditForm = { id };
  if (title !== null) edit.title = title;
  if (tags) edit.tags = tags;
  if (within !== null) edit.within = within;
  if (own !== null) edit.own = true;
  if (picture instanceof Blob) edit.picture = new Uint8Array(await picture.arrayBuffer());
  else if (picture === "page") edit.picture = "page";
  c.set("edit", edit);
  await next();
});

/** The page's words for a link that is gone; core's are written for an agent. */
const LINK_GONE = "That link is gone. Reload the page.";
/** The status for each core refusal an action answers; any other error is thrown on. */
type Refusals = Partial<Record<CoreErrorCode, 400 | 404 | 409>>;
const HOME_REFUSALS: Refusals = { not_found: 404, conflict: 409, invalid_input: 400 };
/** The Save page's refusals: the home ones, and an address core cannot save. */
const SAVE_REFUSALS: Refusals = { ...HOME_REFUSALS, invalid_url: 400 };

/** A refused action answers with its status and message; anything else is thrown on. */
async function homeAction(
  c: Context,
  act: () => Promise<Response>,
  refusals: Refusals = HOME_REFUSALS,
): Promise<Response> {
  try {
    return await act();
  } catch (error) {
    const status = error instanceof CoreError ? refusals[error.code] : undefined;
    if (!(error instanceof CoreError) || status === undefined) throw error;
    const message = error.code === "not_found" ? LINK_GONE : error.message;
    return c.json({ code: error.code, message }, status, NO_STORE);
  }
}

/** The Save page's answer: the link as saved, with its date in the page's words. */
const savedJson = ({ link, created, whyKept }: SavedPage, now: Date) => ({
  id: link.id,
  created,
  whyKept,
  state: link.state,
  savedAt: link.savedAt.toISOString(),
  savedOn: savedOn(link.savedAt, now),
  title: link.title,
  url: link.url,
  why: link.why?.text ?? null,
  putAwayAt: link.putAwayAt?.toISOString() ?? null,
});

/** A Keep handy row as the page holds it between an action and its Undo: dates as ISO strings. */
type ToolJson = {
  status: ToolStatus;
  source: Source;
  since: string;
  answeredAt: string | null;
  waitDays: WaitDays;
};

const toolJson = (t: ToolRecord): ToolJson => ({
  status: t.status,
  source: t.source,
  since: t.since.toISOString(),
  answeredAt: t.answeredAt?.toISOString() ?? null,
  waitDays: t.waitDays,
});

/** Each wait core can store. A Record, so the compiler holds it to exactly `WaitDays`. */
const WAITS: Record<WaitDays, true> = { 30: true, 60: true, 120: true };

/** A row the page sends back: status, source and wait among core's values, and dates that parse. */
export const isToolJson = (value: unknown): value is ToolJson => {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Record<string, unknown>;
  return (
    (TOOL_STATUSES as readonly unknown[]).includes(row.status) &&
    (SOURCES as readonly unknown[]).includes(row.source) &&
    isDate(row.since) &&
    isDateOrNull(row.answeredAt) &&
    typeof row.waitDays === "number" &&
    row.waitDays in WAITS
  );
};
/** A state action's `StateChange` as the page holds it between the action and its Undo: dates as ISO strings. */
type StateChangeJson = {
  before: { state: LinkState; putAwayAt: string | null; snoozedUntil: string | null };
  after: { state: LinkState; putAwayAt: string | null };
  at: string;
};

const iso = (d: Date | null) => d?.toISOString() ?? null;
const stateChangeJson = ({ before, after, at }: StateChange): StateChangeJson => ({
  before: {
    state: before.state,
    putAwayAt: iso(before.putAwayAt),
    snoozedUntil: iso(before.snoozedUntil),
  },
  after: { state: after.state, putAwayAt: iso(after.putAwayAt) },
  at: at.toISOString(),
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;
const isState = (value: unknown): value is LinkState =>
  (STATES as readonly unknown[]).includes(value);

/** A change the page sends back: both sides and the action's time are present, with a state core knows and dates that parse. */
export const isStateChangeJson = (value: unknown): value is StateChangeJson => {
  if (!isRecord(value) || !isRecord(value.before) || !isRecord(value.after)) return false;
  const { before, after } = value;
  return (
    isState(before.state) &&
    isDateOrNull(before.putAwayAt) &&
    isDateOrNull(before.snoozedUntil) &&
    isState(after.state) &&
    isDateOrNull(after.putAwayAt) &&
    isDate(value.at)
  );
};

const date = (value: string | null) => (value === null ? null : new Date(value));
const stateChange = ({ before, after, at }: StateChangeJson): StateChange => ({
  before: {
    state: before.state,
    putAwayAt: date(before.putAwayAt),
    snoozedUntil: date(before.snoozedUntil),
  },
  after: { state: after.state, putAwayAt: date(after.putAwayAt) },
  at: new Date(at),
});

/** An absent row is null; a missing member is refused, never read as null. */
export const isToolJsonOrNull = (value: unknown): value is ToolJson | null =>
  value === null || isToolJson(value);

const toolRecord = (t: ToolJson): ToolRecord => ({
  status: t.status,
  source: t.source,
  since: new Date(t.since),
  answeredAt: t.answeredAt === null ? null : new Date(t.answeredAt),
  waitDays: t.waitDays,
});

/** A tool action's answer: the row it wrote and the row it replaced, which its Undo sends back. */
const toolMoved = (c: Context, change: ToolChange) =>
  c.json(
    { tool: toolJson(change.tool), previous: change.previous && toolJson(change.previous) },
    200,
    NO_STORE,
  );

/** A check row as the page holds it between It still works and its Undo: dates as ISO strings. */
type CheckJson = {
  checkedAt: string;
  result: LinkCheck["result"];
  detail: string | null;
  firstDeadAt: string | null;
  flaggedAt: string | null;
  stillWorksAt: string | null;
};

const checkJson = (c: LinkCheck): CheckJson => ({
  checkedAt: c.checkedAt.toISOString(),
  result: c.result,
  detail: c.detail,
  firstDeadAt: c.firstDeadAt?.toISOString() ?? null,
  flaggedAt: c.flaggedAt?.toISOString() ?? null,
  stillWorksAt: c.stillWorksAt?.toISOString() ?? null,
});

/** A row the page sends back: a result among core's, a string or null detail, and dates that parse. */
const isCheckJson = (value: unknown): value is CheckJson => {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Record<string, unknown>;
  return (
    (CHECK_RESULTS as readonly unknown[]).includes(row.result) &&
    isStringOrNull(row.detail) &&
    isDate(row.checkedAt) &&
    isDateOrNull(row.firstDeadAt) &&
    isDateOrNull(row.flaggedAt) &&
    isDateOrNull(row.stillWorksAt)
  );
};

const checkRecord = (c: CheckJson): LinkCheck => ({
  checkedAt: new Date(c.checkedAt),
  result: c.result,
  detail: c.detail,
  firstDeadAt: c.firstDeadAt === null ? null : new Date(c.firstDeadAt),
  flaggedAt: c.flaggedAt === null ? null : new Date(c.flaggedAt),
  stillWorksAt: c.stillWorksAt === null ? null : new Date(c.stillWorksAt),
});

/** What the owner is told when a Keep handy action is refused; core's words are written for an agent. */
const TOOL_REFUSALS = {
  not_found: { status: 404, message: LINK_GONE },
  conflict: { status: 409, message: "That link's Keep handy state changed. Reload the page." },
  invalid_input: { status: 400, message: "That can't be undone. Reload the page." },
} as const;

/** A refused tool action answers with the owner's words; anything else is thrown on. */
async function toolAction(c: Context, act: () => Promise<Response>): Promise<Response> {
  try {
    return await act();
  } catch (error) {
    if (!(error instanceof CoreError) || !(error.code in TOOL_REFUSALS)) throw error;
    const code = error.code as keyof typeof TOOL_REFUSALS;
    const { status, message } = TOOL_REFUSALS[code];
    return c.json({ code, message }, status, NO_STORE);
  }
}

/** What the owner is told when a note action is refused, by core's error code. */
const NOTE_REFUSALS = {
  not_found: { status: 404, message: "That note is gone. Reload." },
  conflict: { status: 409, message: "An AI changed this note. Reload." },
} as const;

/**
 * Runs a note action and answers 204. A refusal answers with the owner's wording: 404 for a note
 * that is gone, 409 for one an AI changed, and 400 with core's own message for invalid text.
 */
async function noteAction(c: Context, act: () => Promise<void>): Promise<Response> {
  try {
    await act();
    return c.body(null, 204, NO_STORE);
  } catch (error) {
    if (!(error instanceof CoreError)) throw error;
    if (error.code === "not_found" || error.code === "conflict") {
      const { status, message } = NOTE_REFUSALS[error.code];
      return c.json({ code: error.code, message }, status, NO_STORE);
    }
    return c.json({ code: error.code, message: error.message }, 400, NO_STORE);
  }
}

/**
 * Runs a removal or its Undo (of a saved copy or a link) and answers 204. A refusal is core's own
 * 404 wording, which is the owner's; `homeAction` would say the link is gone.
 */
async function removalAction(c: Context, act: () => Promise<void>): Promise<Response> {
  try {
    await act();
    return c.body(null, 204, NO_STORE);
  } catch (error) {
    if (!(error instanceof CoreError) || error.code !== "not_found") throw error;
    return c.json({ code: error.code, message: error.message }, 404, NO_STORE);
  }
}

/** How long the Tags page waits for its suggestions before it shows without them. */
const TAG_SUGGEST_WAIT_MS = 1500;

/**
 * The suggestions, or none when they take longer than `ms` or fail; one line says why. A late
 * embedding is not cancelled: it fills the name cache for the next view.
 */
async function suggestionsWithin(
  ms: number,
  find: () => Promise<TagMergeSuggestion[]>,
): Promise<TagMergeSuggestion[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeUp = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer within ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([find(), timeUp]);
  } catch (error) {
    console.error(
      `[tags] suggestions skipped: ${error instanceof Error ? error.message : String(error)}`,
    );
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/** Runs a suggestion dismissal or its Undo and answers 204; a blank key is a 400 in the owner's words. */
async function pairAction(c: Context, act: () => Promise<void>): Promise<Response> {
  try {
    await act();
    return c.body(null, 204, NO_STORE);
  } catch (error) {
    if (!(error instanceof CoreError)) throw error;
    return c.json(
      { code: error.code, message: "That did not work. Reload the page." },
      400,
      NO_STORE,
    );
  }
}

/** A refused key action answers 400 with the rule's own message; anything else is thrown on. */
function keyAction(c: Context, act: () => Response): Response {
  try {
    return act();
  } catch (error) {
    if (!(error instanceof AgentKeyError || error instanceof KeyStoreError)) throw error;
    return c.json({ code: error.code, message: error.message }, 400, NO_STORE);
  }
}

/**
 * A tag action answers 200 with the tag. A refusal answers in the owner's words, never core's,
 * which are written for an agent: `invalid` for a refused value, and fixed words for a tag that
 * is gone or changed meanwhile. Anything else is thrown on.
 */
async function tagAction(c: Context, invalid: string, act: () => Promise<Tag>) {
  return tagReply(c, invalid, async () => ({ tag: await act() }));
}

/** `tagAction` for an answer of more than the tag; `act` may return its own Response for an outcome that is not a refusal. */
async function tagReply(c: Context, invalid: string, act: () => Promise<object | Response>) {
  try {
    const answer = await act();
    return answer instanceof Response ? answer : c.json(answer, 200, NO_STORE);
  } catch (error) {
    if (!(error instanceof CoreError)) throw error;
    if (error.code === "not_found") {
      const message = "That tag is not there any more. Reload the page.";
      return c.json({ code: error.code, message }, 404, NO_STORE);
    }
    if (error.code === "conflict") {
      const message = "That tag changed while you were editing it. Reload the page and try again.";
      return c.json({ code: error.code, message }, 409, NO_STORE);
    }
    return c.json({ code: error.code, message: invalid }, 400, NO_STORE);
  }
}

/** Undo of a merge or delete: a refusal is core's own wording, 404 when too late and 409 when the tags moved. */
async function undoAction(c: Context, act: () => Promise<object>) {
  try {
    return c.json({ tags: await act() }, 200, NO_STORE);
  } catch (error) {
    if (!(error instanceof CoreError)) throw error;
    if (error.code === "not_found" || error.code === "conflict") {
      const status = error.code === "not_found" ? 404 : 409;
      return c.json({ code: error.code, message: error.message }, status, NO_STORE);
    }
    throw error;
  }
}

/**
 * The web door. `/login` and the OAuth error page are the only pages served without a session:
 * a failed authorization can reach a browser that is not signed in.
 */
export function webApp({
  deps,
  auth,
  withAuthLock,
  consent,
  connections,
  keys,
  baseUrl,
  ai,
}: {
  deps: SearchLinksDeps &
    WorthDeps &
    LinkCheckDeps & {
      store: LinkRemover;
      images: LinkImageReader;
      edits: LinkEditStore;
      tagEdits: TagEditStore;
      tagSuggest: TagSuggestStore;
      names: NameVectors;
      /** How long the Tags page waits for its suggestions; `TAG_SUGGEST_WAIT_MS` when left out. */
      tagSuggestWaitMs?: number | undefined;
      profile: ProfileStore;
      stats: StatsStore;
      /** The stored stats reading, shown on the profile only while `readingOn`. */
      statsReadings: StatsReadingStore;
      readingOn?: boolean | undefined;
      savedCopies: SavedCopyReader &
        SavedCopyRemover &
        Pick<SavedCopyUsage, "usedBytes" | "lastCheck">;
      /** The saved-copy limit, for the usage line on All links; 0 or left out shows none. */
      copyLimitBytes?: number;
      readGate: ReadGate;
      /** The owner's zip export: its state, starting a build, and the prepared file. */
      exports: ExportBuilds;
    };
  auth: Auth;
  withAuthLock: WithAuthLock;
  /** What to show for a signed authorize query; without it there is no consent page. */
  consent?: ((query: string) => Promise<ConsentDetails | null>) | undefined;
  /** The owner's connected apps, and ending one's access. */
  connections: {
    list: (owner: OwnerId) => Promise<ConnectionRow[]>;
    disconnect: (owner: OwnerId, clientId: string) => Promise<unknown>;
  };
  /** The owner's agent keys. A refused action throws `AgentKeyError` or `KeyStoreError`. */
  keys: {
    list: (owner: OwnerId) => KeyInfo[];
    create: (owner: OwnerId, name: string) => { id: number; name: string; key: string };
    turnOff: (owner: OwnerId, id: number) => void;
    turnOn: (owner: OwnerId, id: number) => void;
  };
  /** The server's public origin (`AYE_BASE_URL`), which the bookmarklet opens. */
  baseUrl: string;
  /**
   * The in-app AI, when one is set up: its model, the MCP door's deps (with the search log, so
   * its searches are logged like any agent's), the call tracker shutdown waits on, and the signal
   * that stops every turn when the server stops.
   */
  ai?: { model: ChatModel; deps: McpDeps; track: TrackCall; signal: AbortSignal } | undefined;
}) {
  const app = new Hono<SessionEnv>();
  const session = requireSession(auth, withAuthLock);
  // The Save page alone sends a signed-out owner to sign in and straight back to it (#129).
  const saveSession = requireSession(auth, withAuthLock, loginRedirect);
  const bookmarklet = bookmarkletCode(baseUrl);

  /** The Ask AI panel's details for a menu page, or nothing while no AI is set up (#159). */
  const askOn = (c: Context<SessionEnv>, place: string): Ask | undefined =>
    ai ? { ai: ai.model.name, place, owner: c.get("caller").owner } : undefined;

  const tagDeps = { ...deps, now: deps.now ?? (() => new Date()) };
  const addressOf = (owner: OwnerId, name: string) => tagAddress(tagDeps, owner, name);

  /** A renamed or merged tag's old address: 303 to the same page at the tag's live key, or null when `name` is not one. */
  const oldAddress = async (c: Context<SessionEnv>, name: string): Promise<Response | null> => {
    const current = await addressOf(c.get("caller").owner, name);
    if (current === null || current === tagKey(name)) return null;
    const url = new URL(c.req.url);
    url.searchParams.set("tag", current);
    return c.redirect(`${url.pathname}${url.search}`, 303);
  };

  /**
   * What a card shows after an edit or its Undo, read after the write: its title and picture, its
   * tags, and its space (the color of the card, and the name its grey line shows) as the list the
   * card is on reads it (`view`).
   */
  const cardState = async (owner: OwnerId, id: string, asked: View) => {
    const link = await getLink(deps, owner, id);
    const shown = (await deps.images.imageVersions(owner, [id])).get(id);
    const info = (await deps.images.pictureInfo(owner, [id])).get(id);
    const view: View =
      asked.within === undefined
        ? asked
        : {
            ...asked,
            within: (await addressOf(owner, asked.within).catch(() => null)) ?? asked.within,
          };
    const space = linkSpace(
      link,
      await deps.store.listTags(owner),
      view.within === undefined ? {} : { within: view.within },
    );
    const line = lineSpace(space, view);
    return {
      title: link.title,
      shown: displayTitle(link),
      url: link.url,
      initials: initialsText(link),
      version: shown?.version ?? null,
      fit: shown?.fit ?? null,
      picture: {
        own: info?.own ?? false,
        pageVersion: info?.pageVersion ?? null,
        pageFit: info?.pageFit ?? null,
      },
      tags: shownTags(link.tags),
      space: space && { color: space.color },
      lineSpace: line && { name: line.name },
    };
  };

  app.get("/login", (c) =>
    // No Referer, so the return to a long Save address does not carry this whole URL as a header (#129).
    c.html(loginPage({ next: returnAfterLogin(c.req.query("next") ?? null) }), 200, {
      ...NO_STORE,
      "Referrer-Policy": "no-referrer",
    }),
  );

  app.get(OAUTH_ERROR_PATH, (c) =>
    c.html(oauthErrorPage(oauthErrorMessage(c.req.query("error"))), 200, NO_STORE),
  );

  // Reads only: a cross-site GET carries the Lax session cookie, so it must not use links up.
  app.get("/", session, async (c) => {
    const { owner } = c.get("caller");
    const suggestions = await listSuggestions(deps, owner);
    const { links, gone } = await worthALook(deps, owner, suggestions);
    const cards = [...links.map((d) => d.link), ...(gone ? [gone] : [])];
    const ids = cards.map((l) => l.id);
    const images = await deps.images.imageVersions(owner, ids);
    const pictures = await deps.images.pictureInfo(owner, ids);
    const copies = await deps.savedCopies.copyInfo(owner, ids);
    const views = await linkViews(deps, owner, cards);
    const { spaces, catalog } = await homeSpaces(deps, owner);
    const worth = { links, images, now: deps.now(), catalog, gone, pictures, copies, views };
    const items = await listShelf(deps, owner);
    // Every tile, including those hidden until Show all: the shelf script's fresh copy comes from here.
    const shelfImages = await deps.images.imageVersions(
      owner,
      [...items, ...suggestions].map((t) => t.link.id),
    );
    const shelf = handyShelf({ items, suggestions, catalog, images: shelfImages });
    const tidy = await tidyReady(deps, owner);
    const page = homePage({
      worth,
      shelf,
      spaces: spacesSection(spaces),
      tidy,
      ask: askOn(c, "Home"),
    });
    return c.html(page, 200, NO_STORE);
  });

  // Tidy up (#198): a session of old links. Reading it writes nothing.
  app.get("/tidy", session, async (c) => {
    const { owner } = c.get("caller");
    const queue = await tidyQueue(deps, owner, TIDY_SESSION);
    const hasFocus = (await currentFocus(deps, owner)).length > 0;
    const images = await deps.images.imageVersions(
      owner,
      queue.map((t) => t.link.id),
    );
    const catalog = await deps.store.listTags(owner);
    return c.html(tidyPage({ queue, hasFocus, images, catalog, now: deps.now() }), 200, NO_STORE);
  });

  app.get("/search", session, async (c) => {
    const caller = c.get("caller");
    const query = c.req.query("q") ?? "";
    const keep = c.req.query("keep") === "1";
    // `tag` limits the search to one of the owner's tags, as a space page's Search this space does;
    // a blank one is no tag, and one the owner lacks gets the space page's 404.
    const catalog = await deps.store.listTags(caller.owner);
    const tagName = c.req.query("tag") ?? "";
    let space: Tag | undefined;
    if (tagName.trim() !== "") {
      try {
        const moved = await oldAddress(c, tagName);
        if (moved) return moved;
        space = findSpaceTag(catalog, tagName);
      } catch (error) {
        if (error instanceof CoreError && error.code === "not_found") {
          return c.html(spaceMissingPage(askOn(c, "this page")), 404, NO_STORE);
        }
        throw error;
      }
    }
    // Keep mode lists only links that can go on the shelf.
    const input = {
      query,
      ...(keep ? { state: "active" as const } : {}),
      ...(space ? { tag: space.key } : {}),
    };
    const links = await searchLinks(deps, caller.owner, input, caller.savedBy);
    const images = await deps.images.imageVersions(
      caller.owner,
      links.map((l) => l.id),
    );
    const copies = await deps.savedCopies.copyInfo(
      caller.owner,
      links.map((l) => l.id),
    );
    const pictures = await deps.images.pictureInfo(
      caller.owner,
      links.map((l) => l.id),
    );
    const views = await linkViews(deps, caller.owner, links);
    const handy = new Map([...views].map(([id, v]) => [id, v.handy]));
    const gone = new Map([...views].map(([id, v]) => [id, v.gone]));
    const now = (deps.now ?? (() => new Date()))();
    const html = searchPage({
      query,
      space,
      links,
      now,
      images,
      catalog,
      handy,
      gone,
      keep,
      pictures,
      copies,
      ask: askOn(c, "Search"),
    });
    return c.html(html, 200, NO_STORE);
  });

  // A space names its tag in the query (`spaceHref`). A blank one goes home; a tag the owner does
  // not have, whoever else has it, gets one 404; a changed cursor gets a 400, and one naming a link
  // that is gone restarts at the first page.
  const space = (state: LinkState) => async (c: Context<SessionEnv>) => {
    const name = c.req.query("tag") ?? "";
    if (name.trim() === "") return c.redirect("/", 303);
    const { owner } = c.get("caller");
    const before = c.req.query("before");
    const done = state === "archived";
    // Out of your lists has no sort: it never reads `order`, so its cursors are newest's.
    let order: LinkOrder = "newest";
    try {
      if (!done) order = checkedOrder(c.req.query("order"));
      const moved = await oldAddress(c, name);
      if (moved) return moved;
      const { tag, catalog, page } = await openSpace(deps, owner, {
        name,
        state,
        order,
        limit: LINK_PAGE,
        ...(before === undefined ? {} : { before }),
      });
      const images = await deps.images.imageVersions(
        owner,
        page.links.map((l) => l.id),
      );
      const copies = await deps.savedCopies.copyInfo(
        owner,
        page.links.map((l) => l.id),
      );
      const views = await linkViews(deps, owner, page.links);
      const handy = new Map([...views].map(([id, v]) => [id, v.handy]));
      const gone = new Map([...views].map(([id, v]) => [id, v.gone]));
      const pictures = await deps.images.pictureInfo(
        owner,
        page.links.map((l) => l.id),
      );
      const later = before !== undefined;
      const html = spacePage({
        tag,
        catalog,
        order,
        ...page,
        images,
        handy,
        gone,
        pictures,
        copies,
        now: deps.now(),
        done,
        later,
        ask: askOn(c, tag.name),
        view: viewOf(getCookie(c, VIEW_COOKIE)),
      });
      return c.html(html, 200, NO_STORE);
    } catch (error) {
      if (!(error instanceof CoreError)) throw error;
      if (error.code === "not_found" && before !== undefined) {
        return c.redirect(spaceHref(name, { done, order }), 303);
      }
      if (error.code === "not_found")
        return c.html(spaceMissingPage(askOn(c, "this page")), 404, NO_STORE);
      return c.html(olderInvalidPage(SPACE_RESTART, askOn(c, "this page")), 400, NO_STORE);
    }
  };
  app.get("/spaces", session, space("active"));
  app.get("/spaces/done", session, space("archived"));

  // All links names its order in the query (`allHref`); an unknown order or a changed cursor gets
  // a 400, and one naming a link that is gone restarts at the first page. It reads a page and never
  // a count.
  const all = (state: LinkState) => async (c: Context<SessionEnv>) => {
    const { owner } = c.get("caller");
    const before = c.req.query("before");
    const done = state === "archived";
    let order: LinkOrder = "newest";
    try {
      order = checkedOrder(c.req.query("order"));
      const page = await linkPage(deps, owner, {
        order,
        state,
        limit: LINK_PAGE,
        ...(before === undefined ? {} : { before }),
      });
      const images = await deps.images.imageVersions(
        owner,
        page.links.map((l) => l.id),
      );
      const catalog = await deps.store.listTags(owner);
      const copies = await deps.savedCopies.copyInfo(
        owner,
        page.links.map((l) => l.id),
      );
      const views = await linkViews(deps, owner, page.links);
      const handy = new Map([...views].map(([id, v]) => [id, v.handy]));
      const gone = new Map([...views].map(([id, v]) => [id, v.gone]));
      const pictures = await deps.images.pictureInfo(
        owner,
        page.links.map((l) => l.id),
      );
      const later = before !== undefined;
      const notice =
        done || later ? null : await readCopyNotice(deps.savedCopies, deps.copyLimitBytes ?? 0);
      const html = allPage({
        order,
        ...page,
        catalog,
        images,
        handy,
        gone,
        pictures,
        copies,
        notice,
        now: deps.now(),
        done,
        later,
        ask: askOn(c, "All links"),
        view: viewOf(getCookie(c, VIEW_COOKIE)),
      });
      return c.html(html, 200, NO_STORE);
    } catch (error) {
      if (!(error instanceof CoreError)) throw error;
      if (error.code === "not_found") return c.redirect(allHref(order, { done }), 303);
      return c.html(olderInvalidPage(ALL_RESTART, askOn(c, "this page")), 400, NO_STORE);
    }
  };
  app.get("/all", session, all("active"));
  app.get("/all/done", session, all("archived"));

  // Another owner's link, a link without an image and an id never issued all get this same 404.
  // `?page=1` serves the page's fetched picture, for the edit dialog's "Use the page's picture".
  app.get(IMAGE_ROUTE, session, async (c) => {
    const which = c.req.query("page") === "1" ? "page" : undefined;
    const image = await deps.images.image(c.get("caller").owner, c.req.param("id"), which);
    if (!image) return c.text("Not found.", 404, NO_STORE);
    const cached = c.req.query("v") === image.version;
    return c.body(new Uint8Array(image.bytes), 200, imageHeaders(image.contentType, cached));
  });

  // A picture that is not an `ok` image of the owner's copy answers the same 404 as `/images/:id`.
  // Never cached: removing a copy must hide it at once.
  const copies = createCopyReader({
    store: deps.store,
    copies: deps.savedCopies,
    gate: deps.readGate,
  });
  app.get(COPY_ROUTE, session, async (c) => {
    const { owner } = c.get("caller");
    const view = await copies.view(owner, c.req.param("id"));
    if (view === null) return c.html(copyNotFoundPage(), 404, COPY_HEADERS);
    const from = c.req.query("from");
    const back = backTarget(
      from === undefined ? from : await liveFrom(from, (name) => addressOf(owner, name)),
      from === undefined ? [] : await deps.store.listTags(owner),
    );
    const handy = await handyOf(deps, owner, view.link);
    const html = copyPage(view, (deps.now ?? (() => new Date()))(), back, handy);
    return c.html(html, view.copy === "unreadable" ? 503 : 200, COPY_HEADERS);
  });
  app.get(COPY_IMAGE_ROUTE, session, async (c) => {
    const image = await copies.image(
      c.get("caller").owner,
      c.req.param("id"),
      Number(c.req.param("n")),
    );
    if (image === null) return c.text("Not found.", 404, NO_STORE);
    if (image === "unreadable") return c.text("Unavailable.", 503, NO_STORE);
    return c.body(new Uint8Array(image.bytes), 200, imageHeaders(image.contentType, false));
  });

  app.get("/connections", session, async (c) => {
    const { owner } = c.get("caller");
    const now = (deps.now ?? (() => new Date()))();
    const page = connectionsPage({
      connections: await connections.list(owner),
      keys: keys.list(owner),
      now,
      bookmarklet,
      exportView: deps.exports.view(owner),
      ask: askOn(c, "Apps and keys"),
    });
    return c.html(page, 200, NO_STORE);
  });

  // The links-only export (#130): built at once, sent as a download, never cached.
  app.get(EXPORT_JSON_ROUTE, session, async (c) => {
    const manifest = await exportManifest(
      { ...deps, now: deps.now ?? (() => new Date()) },
      c.get("caller").owner,
    );
    return c.body(JSON.stringify(manifest), 200, {
      ...NO_STORE,
      "Content-Type": "application/json; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
      "Content-Disposition": `attachment; filename="${exportFilename(new Date(manifest.exportedAt), "json")}"`,
    });
  });

  // The whole export (#130): a build runs in the background; the page polls `/connections`.
  app.post(EXPORT_PREPARE_ROUTE, session, (c) =>
    deps.exports.start(c.get("caller").owner) === "started"
      ? c.body(null, 202, NO_STORE)
      : c.json({ code: "already_preparing" }, 409, NO_STORE),
  );
  // The prepared zip, whatever the current state, until it expires; streamed from its file.
  app.get(EXPORT_ZIP_ROUTE, session, async (c) => {
    const file = await deps.exports.download(c.get("caller").owner);
    if (!file) return c.text("Not found.", 404, NO_STORE);
    const headers = {
      ...NO_STORE,
      "Content-Type": "application/zip",
      "Content-Length": String(file.size),
      "X-Content-Type-Options": "nosniff",
      "Content-Disposition": `attachment; filename="${exportFilename(file.exportedAt, "zip")}"`,
    };
    if (c.req.method === "HEAD") {
      await file.body.cancel();
      return c.body(null, 200, headers);
    }
    return c.body(file.body, 200, headers);
  });

  // The Save page (#129). Any site can open it, and the Lax cookie comes along, so it never
  // writes and reads none of the owner's data: it is filled only from its own query.
  app.get(SAVE_PATH, saveSession, (c) =>
    c.html(
      saveForm({
        url: c.req.query("url") ?? "",
        title: c.req.query("title") ?? "",
        long: c.req.query("long") === "1",
      }),
      200,
      SAVE_PAGE_HEADERS,
    ),
  );

  // The Save page's Save (#129). The why is the owner's own, so core records it as "asked", and
  // the link is saved by the session's caller. A repeat save answers the link already saved.
  const saveBody = { url: isString, title: isStringOrNull, why: isStringOrNull };
  app.post(SAVE_PATH, jsonBody(saveBody), session, (c) =>
    homeAction(
      c,
      async () => {
        const { owner, savedBy } = c.get("caller");
        const { url, title, why } = c.get("body");
        const saved = await savePage(deps, owner, { url, title, why, savedBy });
        return c.json(savedJson(saved, deps.now()), 200, NO_STORE);
      },
      SAVE_REFUSALS,
    ),
  );

  // The home cards' buttons. Recording an opening is a POST, never a redirect route: a GET that
  // writes could be set off from another site.
  const linkId = { id: isLinkId };
  const done = (c: Context) => c.body(null, 204, NO_STORE);

  app.post("/links/copy/remove", jsonBody(linkId), session, (c) =>
    removalAction(c, () => removeSavedCopy(deps, c.get("caller").owner, c.get("body").id)),
  );

  // The Undo of a remove.
  app.post("/links/copy/restore", jsonBody(linkId), session, (c) =>
    removalAction(c, () => restoreSavedCopy(deps, c.get("caller").owner, c.get("body").id)),
  );

  app.post("/links/delete", jsonBody(linkId), session, (c) =>
    removalAction(c, () => deleteLink(deps, c.get("caller").owner, c.get("body").id)),
  );

  // The Undo of a delete.
  app.post("/links/restore", jsonBody(linkId), session, (c) =>
    removalAction(c, () => restoreLink(deps, c.get("caller").owner, c.get("body").id)),
  );

  app.post("/home/opened", jsonBody(linkId), session, (c) =>
    homeAction(c, async () => {
      await markOpened(deps, c.get("caller").owner, c.get("body").id);
      return done(c);
    }),
  );

  // An opening from any other page (search, All links, a space): recorded, but not a nudge.
  app.post("/links/opened", jsonBody(linkId), session, (c) =>
    homeAction(c, async () => {
      await recordOpening(deps, c.get("caller").owner, c.get("body").id);
      return done(c);
    }),
  );

  // The owner's edit of a link's title, picture and tags (#145, #239). It answers the card's new
  // state and the edit's id for its Undo (null when nothing changed). A change of tags that the
  // link's tags have moved on from since the dialog opened is a 409, with nothing written.
  app.post("/links/edit", session, editForm, (c) =>
    homeAction(c, async () => {
      const { owner } = c.get("caller");
      const { id, title, picture, tags, within, own } = c.get("edit");
      const editId = await editLink(deps, owner, id, {
        ...(title !== undefined && { title }),
        ...(picture !== undefined && { picture }),
        ...(tags !== undefined && { tags }),
      });
      const view: View = { ...(within !== undefined && { within }), ...(own && { own }) };
      return c.json({ ...(await cardState(owner, id, view)), editId }, 200, NO_STORE);
    }),
  );

  // Its Undo: core puts the edit back only while nothing changed since; otherwise a 409.
  app.post(
    "/links/edit/undo",
    jsonBody({ ...linkId, editId: isString, within: optional(isString), own: optional(isOne) }),
    session,
    (c) =>
      homeAction(c, async () => {
        const { owner } = c.get("caller");
        const { id, editId, within, own } = c.get("body");
        await undoEdit(deps, owner, id, editId);
        const view: View = { ...(within !== undefined && { within }), ...(own && { own: true }) };
        return c.json(await cardState(owner, id, view), 200, NO_STORE);
      }),
  );

  // The names of the owner's tags, for the edit dialog's suggestions.
  app.get("/tags/names", session, async (c) => {
    const tags = await deps.store.listTags(c.get("caller").owner);
    return c.json({ names: tags.map((t) => t.name) }, 200, NO_STORE);
  });

  // Keep in Tidy up: the link stays in the lists and out of the next sessions for a while.
  app.post("/tidy/keep", jsonBody(linkId), session, (c) =>
    homeAction(c, async () => {
      await keepInTidy(deps, c.get("caller").owner, c.get("body").id);
      return done(c);
    }),
  );

  app.post("/home/snooze", jsonBody(linkId), session, (c) =>
    homeAction(c, async () => {
      const snooze = await snoozeLink(deps, c.get("caller").owner, c.get("body").id);
      return c.json(
        {
          until: snooze.until.toISOString(),
          claimedAt: snooze.claimedAt?.toISOString() ?? null,
          previousSurfacedAt: snooze.previousSurfacedAt?.toISOString() ?? null,
        },
        200,
        NO_STORE,
      );
    }),
  );

  const undoSnooze = { until: isDate, claimedAt: isDateOrNull, previousSurfacedAt: isDateOrNull };
  app.post("/home/unsnooze", jsonBody({ ...linkId, ...undoSnooze }), session, (c) =>
    homeAction(c, async () => {
      const { id, until, claimedAt, previousSurfacedAt } = c.get("body");
      await unsnoozeLink(deps, c.get("caller").owner, id, {
        until: new Date(until),
        claimedAt: claimedAt === null ? null : new Date(claimedAt),
        previousSurfacedAt: previousSurfacedAt === null ? null : new Date(previousSurfacedAt),
      });
      return done(c);
    }),
  );

  // It's stale, Put it away and Bring it back answer the change they made; the page sends it
  // back, as it got it, to `/home/undo-state`.
  const stateActions = [
    ["/home/archive", archiveLink],
    ["/home/put-away", putAwayLink],
    ["/home/bring-back", bringBackLink],
  ] as const;
  for (const [path, act] of stateActions) {
    app.post(path, jsonBody(linkId), session, (c) =>
      homeAction(c, async () =>
        c.json(
          stateChangeJson(await act(deps, c.get("caller").owner, c.get("body").id)),
          200,
          NO_STORE,
        ),
      ),
    );
  }

  app.post("/home/undo-state", jsonBody({ ...linkId, change: isStateChangeJson }), session, (c) =>
    homeAction(c, async () => {
      const { id, change } = c.get("body");
      await undoStateChange(deps, c.get("caller").owner, id, stateChange(change));
      return done(c);
    }),
  );

  app.post("/home/why", jsonBody({ ...linkId, text: isString }), session, (c) =>
    homeAction(c, async () => {
      const { id, text } = c.get("body");
      await tellWhy(deps, c.get("caller").owner, id, text);
      return done(c);
    }),
  );

  // Keep handy. A choice the owner makes on the page sends "stated"; answering the page's
  // "Still using?" sends "asked", and core keeps the row's own source. Each answers the row it
  // wrote and the one it replaced.
  app.post("/tools/keep", jsonBody(linkId), session, (c) =>
    toolAction(c, async () =>
      toolMoved(c, await keepHandy(deps, c.get("caller").owner, c.get("body").id, "stated")),
    ),
  );

  app.post("/tools/not-handy", jsonBody(linkId), session, (c) =>
    toolAction(c, async () =>
      toolMoved(c, await notHandy(deps, c.get("caller").owner, c.get("body").id, "stated")),
    ),
  );

  app.post("/tools/still-using", jsonBody(linkId), session, (c) =>
    toolAction(c, async () =>
      toolMoved(c, await stillUsing(deps, c.get("caller").owner, c.get("body").id, "asked")),
    ),
  );

  app.post("/tools/suggestion", jsonBody({ ...linkId, keep: isBoolean }), session, (c) =>
    toolAction(c, async () => {
      const { id, keep } = c.get("body");
      return toolMoved(c, await answerSuggestion(deps, c.get("caller").owner, id, keep));
    }),
  );

  // The Undo of a tool action: puts `previous` back (null: no row) while the row still holds
  // `tool`, the row the action answered. Core refuses a row no action could write.
  const undoTool = { tool: isToolJson, previous: isToolJsonOrNull };
  app.post("/tools/undo", jsonBody({ ...linkId, ...undoTool }), session, (c) =>
    toolAction(c, async () => {
      const { id, tool, previous } = c.get("body");
      const restored = previous && toolRecord(previous);
      await restoreTool(deps, c.get("caller").owner, id, restored, toolRecord(tool));
      return done(c);
    }),
  );

  // It still works on a gone link. Answers the row it wrote and the one it replaced; core's
  // words reach the page as they are.
  app.post("/links/still-works", jsonBody(linkId), session, (c) =>
    homeAction(c, async () => {
      const change = await stillWorks(deps, c.get("caller").owner, c.get("body").id);
      return c.json(
        { check: checkJson(change.check), previous: checkJson(change.previous) },
        200,
        NO_STORE,
      );
    }),
  );

  // The Undo of It still works: puts `previous` back while the row still holds `check`.
  const undoCheck = { check: isCheckJson, previous: isCheckJson };
  app.post("/links/still-works/undo", jsonBody({ ...linkId, ...undoCheck }), session, (c) =>
    homeAction(c, async () => {
      const { id, check, previous } = c.get("body");
      await restoreCheck(
        deps,
        c.get("caller").owner,
        id,
        checkRecord(previous),
        checkRecord(check),
      );
      return done(c);
    }),
  );

  // 204 whether or not the app was connected; the page reloads either way.
  app.post("/connections/disconnect", jsonBody({ clientId: isString }), session, async (c) => {
    await connections.disconnect(c.get("caller").owner, c.get("body").clientId);
    return c.body(null, 204, NO_STORE);
  });

  // The key is in this response only; the page shows it once and never puts it in a URL.
  app.post("/connections/keys", jsonBody({ name: isString }), session, (c) =>
    keyAction(c, () =>
      c.json(keys.create(c.get("caller").owner, c.get("body").name), 200, NO_STORE),
    ),
  );

  app.post("/connections/keys/turn-off", jsonBody({ id: isId }), session, (c) =>
    keyAction(c, () => {
      keys.turnOff(c.get("caller").owner, c.get("body").id);
      return c.body(null, 204, NO_STORE);
    }),
  );

  // The Undo of a turn-off.
  app.post("/connections/keys/turn-on", jsonBody({ id: isId }), session, (c) =>
    keyAction(c, () => {
      keys.turnOn(c.get("caller").owner, c.get("body").id);
      return c.body(null, 204, NO_STORE);
    }),
  );

  app.get("/tags", session, async (c) => {
    const { owner } = c.get("caller");
    const [tags, suggestions] = await Promise.all([
      listTagsWithCounts(tagDeps, owner),
      suggestionsWithin(deps.tagSuggestWaitMs ?? TAG_SUGGEST_WAIT_MS, () =>
        suggestTagMerges(tagDeps, owner),
      ),
    ]);
    return c.html(tagsPage({ tags, suggestions, ask: askOn(c, "Tags") }), 200, NO_STORE);
  });

  // Not these, and its Undo: the keys of the two tags. Both answer 204.
  const pairBody = jsonBody({ a: isString, b: isString });
  app.post("/tags/suggestions/dismiss", pairBody, session, (c) =>
    pairAction(c, () =>
      dismissTagPair(tagDeps, c.get("caller").owner, c.get("body").a, c.get("body").b),
    ),
  );
  app.post("/tags/suggestions/undismiss", pairBody, session, (c) =>
    pairAction(c, () =>
      undismissTagPair(tagDeps, c.get("caller").owner, c.get("body").a, c.get("body").b),
    ),
  );

  // Each tag action names the tag by its key; core matches it as a name.
  const tagBody = <S extends Record<string, Check<unknown>>>(shape: S) =>
    jsonBody({ key: isString, ...shape });

  app.post("/tags/pin", tagBody({ pinned: isBoolean }), session, (c) =>
    tagAction(c, "That did not work. Reload the page and try again.", () =>
      setTagPinned(deps, c.get("caller").owner, {
        name: c.get("body").key,
        pinned: c.get("body").pinned,
      }),
    ),
  );

  app.post("/tags/color", tagBody({ color: isString }), session, (c) =>
    tagAction(c, "Pick one of the six colors.", () =>
      setTagColor(deps, c.get("caller").owner, {
        name: c.get("body").key,
        color: c.get("body").color as SpaceColor,
      }),
    ),
  );

  app.post("/tags/kind", tagBody({ kind: isString }), session, (c) =>
    tagAction(c, "Pick Topic or Project.", () =>
      changeTagKind(deps, c.get("caller").owner, {
        name: c.get("body").key,
        kind: c.get("body").kind as TagKind,
      }),
    ),
  );

  app.post("/tags/status", tagBody({ status: isString }), session, (c) =>
    tagAction(c, "Only a project can be done or reopened. Make it a project first.", () =>
      setProjectStatus(deps, c.get("caller").owner, {
        name: c.get("body").key,
        status: c.get("body").status as "active" | "done",
      }),
    ),
  );

  app.post("/tags/rename", tagBody({ name: isString }), session, (c) =>
    tagReply(c, "Type a new name for the tag.", async () => {
      const done = await renameTag(tagDeps, c.get("caller").owner, {
        name: c.get("body").key,
        newName: c.get("body").name,
      });
      if ("renamed" in done) return { tag: done.renamed };
      const { taken: tag, links } = done;
      const message = `You already have a tag called ${tag.name} (${links === 1 ? "1 link" : `${links} links`}).`;
      return c.json({ code: "taken", tag, links, message }, 409, NO_STORE);
    }),
  );

  app.post("/tags/merge", tagBody({ into: isString }), session, (c) =>
    tagReply(c, "Pick a different tag to merge into.", () =>
      mergeTags(tagDeps, c.get("caller").owner, {
        name: c.get("body").key,
        into: c.get("body").into,
      }),
    ),
  );

  app.post("/tags/delete", tagBody({}), session, (c) =>
    tagReply(c, "That did not work. Reload the page and try again.", () =>
      deleteTag(tagDeps, c.get("caller").owner, { name: c.get("body").key }),
    ),
  );

  app.post("/tags/undo", jsonBody({ changeId: isString }), session, (c) =>
    undoAction(c, () => undoTagChange(tagDeps, c.get("caller").owner, c.get("body").changeId)),
  );

  app.get("/profile", session, async (c) => {
    const { owner } = c.get("caller");
    const { notes, recentFocus } = await profileContext(deps, owner);
    const [stats, reading] = await Promise.all([
      getStats(deps, owner, parseWindow(c.req.query("window"))),
      statsReading({ readings: deps.statsReadings, readingOn: deps.readingOn }, owner),
    ]);
    return c.html(
      profilePage({
        notes,
        focus: recentFocus,
        stats,
        reading,
        now: deps.now(),
        ask: askOn(c, "Profile"),
      }),
      200,
      NO_STORE,
    );
  });

  app.post("/profile/notes/add", jsonBody({ text: isString }), session, (c) =>
    noteAction(c, () => {
      const { owner, savedBy } = c.get("caller");
      return addOwnerNote(deps, owner, savedBy, c.get("body").text);
    }),
  );

  const noteVersion = { id: isString, updatedAt: isSafeInteger };

  // Edit and That's right: confirming a guess is an edit with the text shown.
  for (const path of ["/profile/notes/edit", "/profile/notes/confirm"]) {
    app.post(path, jsonBody({ ...noteVersion, text: isString }), session, (c) =>
      noteAction(c, () => {
        const { owner, savedBy } = c.get("caller");
        const { id, updatedAt, text } = c.get("body");
        return editOwnerNote(deps, owner, savedBy, { id, text, updatedAt: new Date(updatedAt) });
      }),
    );
  }

  app.post("/profile/notes/remove", jsonBody(noteVersion), session, (c) =>
    noteAction(c, () => {
      const { owner, savedBy } = c.get("caller");
      const { id, updatedAt } = c.get("body");
      return removeNote(deps, owner, savedBy, { id, updatedAt: new Date(updatedAt) });
    }),
  );

  // The Undo of a remove.
  app.post("/profile/notes/restore", jsonBody({ id: isString }), session, (c) =>
    noteAction(c, () => restoreNote(deps, c.get("caller").owner, c.get("body").id)),
  );

  // One turn of the in-app chat, run with the owner's own MCP tools as the in-app AI. The session
  // comes first, as for the edit form: a signed-out caller has no large body read. The answer is
  // 200 whether or not the AI answered, so a failed turn still lists the changes it made.
  if (ai) {
    app.post("/ai/chat", session, chatBody, async (c) => {
      const { history, text, page } = c.get("turn");
      const name = ai.model.name;
      const { owner } = c.get("caller");
      const answer = async (result: TurnResult) =>
        c.json(await chatAnswer(deps, owner, name, result), 200, NO_STORE);
      let tools: ToolSession;
      try {
        tools = await openToolSession(ai.deps, inAppCaller(c.get("caller"), name), ai.track);
      } catch (error) {
        console.error("[ai-chat] the tool session didn't open:", error);
        return answer({ ok: false, reason: SERVER_FAULT, changes: [], seen: [] });
      }
      try {
        // A turn stops when the server stops or when the browser drops this request (which
        // @hono/node-server aborts), so a dropped request starts no more model or tool calls. Its
        // answer then reaches no one, so the reason it gives doesn't matter.
        const signal = AbortSignal.any([c.req.raw.signal, ai.signal]);
        const turn = { model: ai.model, session: tools, history, text, page, signal };
        return answer(await runChatTurn(turn));
      } finally {
        // A failed close must not lose the answer and its changes.
        await tools
          .close()
          .catch((error: unknown) =>
            console.error("[ai-chat] the tool session didn't close:", error),
          );
      }
    });
  } else {
    app.post("/ai/chat", session, (c) => c.json({ code: "NO_AI" }, 404, NO_STORE));
  }

  // One card for the panel, to replace a stale one. It needs no AI, so it is mounted either way.
  app.get("/ai/card/:id{[0-9]+}", session, async (c) => {
    const card = await askCard(deps, c.get("caller").owner, c.req.param("id"));
    return card === null
      ? c.json({ code: "not_found" }, 404, NO_STORE)
      : c.json({ card }, 200, NO_STORE);
  });

  if (consent) {
    app.get("/consent", session, async (c) => {
      const details = await consent(new URL(c.req.url).search.slice(1));
      return details
        ? c.html(consentPage(details), 200, NO_STORE)
        : c.html(consentExpiredPage(), 400, NO_STORE);
    });
  }

  return app;
}
