import { type Context, Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { AgentKeyError } from "../auth/agent-keys.js";
import type { WithAuthLock } from "../auth/auth-lock.js";
import type { Auth } from "../auth/better-auth.js";
import type { ConsentDetails } from "../auth/consent.js";
import { AUTH_BODY_LIMIT, BodyTooLarge, readCapped } from "../auth/http.js";
import { loginRedirect, returnAfterLogin, SAVE_PATH } from "../auth/login-return.js";
import { OAUTH_ERROR_PATH, oauthErrorMessage } from "../auth/oauth-error.js";
import { createCopyReader, type ReadGate } from "../core/copy-reading.js";
import { removeSavedCopy, restoreSavedCopy } from "../core/copy-removal.js";
import { readCopyNotice } from "../core/copy-usage.js";
import { CoreError, type CoreErrorCode } from "../core/errors.js";
import { exportFilename, exportManifest } from "../core/export-format.js";
import type { LinkImageReader } from "../core/image-store.js";
import { MAX_IMAGE_BYTES } from "../core/image-type.js";
import { type LinkCheckDeps, restoreCheck, stillWorks } from "../core/link-check.js";
import { CHECK_RESULTS, type LinkCheck } from "../core/link-check-store.js";
import { editLink, undoEdit } from "../core/link-edit.js";
import type { LinkEditStore } from "../core/link-edit-store.js";
import { checkedOrder, linkPage } from "../core/link-pages.js";
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
import { type SearchLinksDeps, searchLinks } from "../core/search-links.js";
import { homeSpaces, openSpace } from "../core/spaces.js";
import { changeTagKind } from "../core/tag-kind.js";
import { type SpaceColor, setTagColor, setTagPinned } from "../core/tag-space.js";
import type { ToolRecord, WaitDays } from "../core/tool-store.js";
import {
  answerSuggestion,
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
  type Tag,
  type TagKind,
  TOOL_STATUSES,
  type ToolStatus,
} from "../core/types.js";
import {
  archiveLink,
  markOpened,
  snoozeLink,
  tellWhy,
  unarchiveLink,
  unsnoozeLink,
  type WorthDeps,
  worthALook,
} from "../core/worth-a-look.js";
import { type KeyInfo, KeyStoreError } from "../store/key-store.js";
import { ALL_RESTART, allPage } from "./all-page.js";
import { bookmarkletCode } from "./bookmarklet.js";
import { type ConnectionRow, connectionsPage } from "./connections-page.js";
import { COPY_HEADERS, copyNotFoundPage, copyPage } from "./copy-page.js";
import { handyShelf } from "./handy-shelf.js";
import { homePage } from "./home-page.js";
import { initialsText } from "./initials.js";
import { savedOn } from "./page.js";
import { consentExpiredPage, consentPage, loginPage, oauthErrorPage, searchPage } from "./pages.js";
import { profilePage } from "./profile-page.js";
import { requireSession, type SessionEnv } from "./require-session.js";
import { saveForm } from "./save-form.js";
import { olderInvalidPage } from "./show-older.js";
import { SPACE_RESTART, spaceMissingPage, spacePage } from "./space-page.js";
import { spacesSection } from "./spaces-section.js";
import { tagsPage } from "./tags-page.js";

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

/**
 * Takes a JSON body under the auth body cap, so any client id that can connect fits, and sets
 * `body` to it when it is an object whose members pass each check in `shape`. Other members are
 * ignored. This checks types only; the rules are core's.
 */
const jsonBody = <S extends Record<string, Check<unknown>>>(shape: S) =>
  createMiddleware<{ Variables: { body: Shaped<S> } }>(async (c, next) => {
    let raw: Uint8Array | null;
    try {
      raw = await readCapped(c.req.raw, AUTH_BODY_LIMIT);
    } catch (error) {
      if (!(error instanceof BodyTooLarge)) throw error;
      return c.json({ code: "PAYLOAD_TOO_LARGE", message: "Request body too large." }, 413);
    }
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder().decode(raw ?? new Uint8Array()));
    } catch {}
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

/** The edit form's cap: the largest picture core keeps, plus the auth cap for the other fields. */
const EDIT_BODY_LIMIT = MAX_IMAGE_BYTES + AUTH_BODY_LIMIT;

/** The edit form as the door read it: only the fields the page sent. */
type EditForm = { id: string; title?: string; picture?: Uint8Array | "page" };

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
    c.json({ code: "BAD_REQUEST", message: "Send a form with id, and title or picture." }, 400);
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
  if (!isLinkId(id) || (title !== null && typeof title !== "string")) return bad();
  if (picture !== null && picture !== "page" && !(picture instanceof Blob)) return bad();
  const edit: EditForm = { id };
  if (title !== null) edit.title = title;
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
const isToolJson = (value: unknown): value is ToolJson => {
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
/** An absent row is null; a missing member is refused, never read as null. */
const isToolJsonOrNull = (value: unknown): value is ToolJson | null =>
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
 * Runs a copy action and answers 204. A refusal is core's own 404 wording, which is the owner's;
 * `homeAction` would say the link is gone.
 */
async function copyAction(c: Context, act: () => Promise<void>): Promise<Response> {
  try {
    await act();
    return c.body(null, 204, NO_STORE);
  } catch (error) {
    if (!(error instanceof CoreError) || error.code !== "not_found") throw error;
    return c.json({ code: error.code, message: error.message }, 404, NO_STORE);
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
  try {
    return c.json({ tag: await act() }, 200, NO_STORE);
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
}: {
  deps: SearchLinksDeps &
    WorthDeps &
    LinkCheckDeps & {
      images: LinkImageReader;
      edits: LinkEditStore;
      profile: ProfileStore;
      savedCopies: SavedCopyReader &
        SavedCopyRemover &
        Pick<SavedCopyUsage, "usedBytes" | "lastCheck">;
      /** The saved-copy limit, for the usage line on All links; 0 or left out shows none. */
      copyLimitBytes?: number;
      readGate: ReadGate;
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
}) {
  const app = new Hono<SessionEnv>();
  const session = requireSession(auth, withAuthLock);
  // The Save page alone sends a signed-out owner to sign in and straight back to it (#129).
  const saveSession = requireSession(auth, withAuthLock, loginRedirect);
  const bookmarklet = bookmarkletCode(baseUrl);

  /** What a card shows after an edit or its Undo, read after the write. */
  const cardState = async (owner: OwnerId, id: string) => {
    const link = await getLink(deps, owner, id);
    const shown = (await deps.images.imageVersions(owner, [id])).get(id);
    const info = (await deps.images.pictureInfo(owner, [id])).get(id);
    return {
      title: link.title,
      url: link.url,
      initials: initialsText(link),
      version: shown?.version ?? null,
      fit: shown?.fit ?? null,
      picture: {
        own: info?.own ?? false,
        pageVersion: info?.pageVersion ?? null,
        pageFit: info?.pageFit ?? null,
      },
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
    const images = await deps.images.imageVersions(owner, [
      ...links.map((d) => d.link.id),
      ...(gone ? [gone.id] : []),
    ]);
    const { spaces, catalog } = await homeSpaces(deps, owner);
    const goneCopy = gone
      ? ((await deps.savedCopies.copyInfo(owner, [gone.id])).get(gone.id) ?? null)
      : null;
    const worth = { links, images, now: deps.now(), catalog, gone, goneCopy };
    const items = await listShelf(deps, owner);
    // Every tile, including those hidden until Show all: the shelf script's fresh copy comes from here.
    const shelfImages = await deps.images.imageVersions(
      owner,
      [...items, ...suggestions].map((t) => t.link.id),
    );
    const shelf = handyShelf({ items, suggestions, catalog, images: shelfImages });
    const page = homePage({ worth, shelf, spaces: spacesSection(spaces) });
    return c.html(page, 200, NO_STORE);
  });

  app.get("/search", session, async (c) => {
    const caller = c.get("caller");
    const query = c.req.query("q") ?? "";
    const keep = c.req.query("keep") === "1";
    // Keep mode lists only links that can go on the shelf.
    const input = keep ? { query, state: "active" as const } : { query };
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
    const catalog = await deps.store.listTags(caller.owner);
    const views = await linkViews(deps, caller.owner, links);
    const handy = new Map([...views].map(([id, v]) => [id, v.handy]));
    const gone = new Map([...views].map(([id, v]) => [id, v.gone]));
    const now = (deps.now ?? (() => new Date()))();
    const html = searchPage({
      query,
      links,
      now,
      images,
      catalog,
      handy,
      gone,
      keep,
      pictures,
      copies,
    });
    return c.html(html, 200, NO_STORE);
  });

  // A space names its tag in the query (`spaceHref`). A blank one goes home; a tag the owner does
  // not have, whoever else has it, gets one 404; a changed cursor gets a 400.
  const space = (state: LinkState) => async (c: Context<SessionEnv>) => {
    const name = c.req.query("tag") ?? "";
    if (name.trim() === "") return c.redirect("/", 303);
    const { owner } = c.get("caller");
    const before = c.req.query("before");
    const done = state === "archived";
    try {
      const { tag, catalog, page } = await openSpace(deps, owner, {
        name,
        state,
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
      const pictures = done
        ? new Map()
        : await deps.images.pictureInfo(
            owner,
            page.links.map((l) => l.id),
          );
      const later = before !== undefined;
      const html = spacePage({
        tag,
        catalog,
        ...page,
        images,
        handy,
        gone,
        pictures,
        copies,
        now: deps.now(),
        done,
        later,
      });
      return c.html(html, 200, NO_STORE);
    } catch (error) {
      if (!(error instanceof CoreError)) throw error;
      if (error.code === "not_found") return c.html(spaceMissingPage(), 404, NO_STORE);
      return c.html(olderInvalidPage(SPACE_RESTART), 400, NO_STORE);
    }
  };
  app.get("/spaces", session, space("active"));
  app.get("/spaces/done", session, space("archived"));

  // All links names its order in the query (`allHref`); an unknown order or a changed cursor gets
  // a 400. It reads a page and never a count.
  const all = (state: LinkState) => async (c: Context<SessionEnv>) => {
    const { owner } = c.get("caller");
    const before = c.req.query("before");
    const done = state === "archived";
    try {
      const order = checkedOrder(c.req.query("order"));
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
      const pictures = done
        ? new Map()
        : await deps.images.pictureInfo(
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
      });
      return c.html(html, 200, NO_STORE);
    } catch (error) {
      if (!(error instanceof CoreError)) throw error;
      return c.html(olderInvalidPage(ALL_RESTART), 400, NO_STORE);
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
    const view = await copies.view(c.get("caller").owner, c.req.param("id"));
    if (view === null) return c.html(copyNotFoundPage(), 404, COPY_HEADERS);
    const html = copyPage(view, (deps.now ?? (() => new Date()))());
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
      exportView: { state: "idle" },
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
    copyAction(c, () => removeSavedCopy(deps, c.get("caller").owner, c.get("body").id)),
  );

  // The Undo of a remove.
  app.post("/links/copy/restore", jsonBody(linkId), session, (c) =>
    copyAction(c, () => restoreSavedCopy(deps, c.get("caller").owner, c.get("body").id)),
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

  // The owner's edit of a link's title and picture (#145). It answers the card's new state and
  // the edit's id for its Undo (null when nothing changed).
  app.post("/links/edit", session, editForm, (c) =>
    homeAction(c, async () => {
      const { owner } = c.get("caller");
      const { id, title, picture } = c.get("edit");
      const editId = await editLink(deps, owner, id, {
        ...(title !== undefined && { title }),
        ...(picture !== undefined && { picture }),
      });
      return c.json({ ...(await cardState(owner, id)), editId }, 200, NO_STORE);
    }),
  );

  // Its Undo: core puts the edit back only while nothing changed since; otherwise a 409.
  app.post("/links/edit/undo", jsonBody({ ...linkId, editId: isString }), session, (c) =>
    homeAction(c, async () => {
      const { owner } = c.get("caller");
      const { id, editId } = c.get("body");
      await undoEdit(deps, owner, id, editId);
      return c.json(await cardState(owner, id), 200, NO_STORE);
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

  app.post("/home/archive", jsonBody(linkId), session, (c) =>
    homeAction(c, async () => {
      await archiveLink(deps, c.get("caller").owner, c.get("body").id);
      return done(c);
    }),
  );

  app.post("/home/unarchive", jsonBody(linkId), session, (c) =>
    homeAction(c, async () => {
      await unarchiveLink(deps, c.get("caller").owner, c.get("body").id);
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

  app.get("/tags", session, async (c) =>
    c.html(tagsPage({ tags: await deps.store.listTags(c.get("caller").owner) }), 200, NO_STORE),
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

  app.get("/profile", session, async (c) => {
    const { owner } = c.get("caller");
    const { notes, recentFocus } = await profileContext(deps, owner);
    return c.html(profilePage({ notes, focus: recentFocus, now: deps.now() }), 200, NO_STORE);
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
