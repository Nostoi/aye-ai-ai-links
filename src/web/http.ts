import { type Context, Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { AgentKeyError } from "../auth/agent-keys.js";
import type { WithAuthLock } from "../auth/auth-lock.js";
import type { Auth } from "../auth/better-auth.js";
import type { ConsentDetails } from "../auth/consent.js";
import { AUTH_BODY_LIMIT, BodyTooLarge, readCapped } from "../auth/http.js";
import { returnAfterLogin } from "../auth/login-return.js";
import { OAUTH_ERROR_PATH, oauthErrorMessage } from "../auth/oauth-error.js";
import { CoreError } from "../core/errors.js";
import type { LinkImageReader } from "../core/image-store.js";
import {
  addOwnerNote,
  editOwnerNote,
  profileContext,
  removeNote,
  restoreNote,
} from "../core/profile.js";
import type { ProfileStore } from "../core/profile-store.js";
import { setProjectStatus } from "../core/project-status.js";
import { type SearchLinksDeps, searchLinks } from "../core/search-links.js";
import { homeSpaces, openSpace } from "../core/spaces.js";
import { changeTagKind } from "../core/tag-kind.js";
import { type SpaceColor, setTagColor, setTagPinned } from "../core/tag-space.js";
import type { LinkState, OwnerId, Tag, TagKind } from "../core/types.js";
import { type KeyInfo, KeyStoreError } from "../store/key-store.js";
import { type ConnectionRow, connectionsPage } from "./connections-page.js";
import {
  consentExpiredPage,
  consentPage,
  homePage,
  loginPage,
  oauthErrorPage,
  searchPage,
} from "./pages.js";
import { profilePage } from "./profile-page.js";
import { requireSession, type SessionEnv } from "./require-session.js";
import { olderInvalidPage, spaceMissingPage, spacePage } from "./space-page.js";
import { spacesSection } from "./spaces-section.js";
import { tagsPage } from "./tags-page.js";

/** How many links a space page shows at a time. */
const SPACE_PAGE = 24;

/** Pages show one person's data, so no browser or proxy may keep a copy. */
const NO_STORE = { "Cache-Control": "no-store" };

/** A link's stored preview image. The id must be digits; anything else is not this route. */
export const IMAGE_ROUTE = "/images/:id{[0-9]+}";

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
const isBoolean: Check<boolean> = (value) => typeof value === "boolean";
const isSafeInteger = (value: unknown): value is number => Number.isSafeInteger(value);
const isId = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;

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
}: {
  deps: SearchLinksDeps & { images: LinkImageReader; profile: ProfileStore; now: () => Date };
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
}) {
  const app = new Hono<SessionEnv>();
  const session = requireSession(auth, withAuthLock);

  app.get("/login", (c) =>
    c.html(loginPage({ next: returnAfterLogin(c.req.query("next") ?? null) }), 200, NO_STORE),
  );

  app.get(OAUTH_ERROR_PATH, (c) =>
    c.html(oauthErrorPage(oauthErrorMessage(c.req.query("error"))), 200, NO_STORE),
  );

  app.get("/", session, async (c) => {
    const spaces = spacesSection(await homeSpaces(deps, c.get("caller").owner));
    return c.html(homePage({ spaces }), 200, NO_STORE);
  });

  app.get("/search", session, async (c) => {
    const caller = c.get("caller");
    const query = c.req.query("q") ?? "";
    const links = await searchLinks(deps, caller.owner, { query }, caller.savedBy);
    const images = await deps.images.imageVersions(
      caller.owner,
      links.map((l) => l.id),
    );
    const catalog = await deps.store.listTags(caller.owner);
    const now = (deps.now ?? (() => new Date()))();
    return c.html(searchPage({ query, links, now, images, catalog }), 200, NO_STORE);
  });

  // A space names its tag in the query (`spaceHref`). A blank one goes home; a tag the owner does
  // not have, whoever else has it, gets one 404; a changed cursor gets a 400.
  const space = (state: LinkState) => async (c: Context<SessionEnv>) => {
    const name = c.req.query("tag") ?? "";
    if (name.trim() === "") return c.redirect("/", 303);
    const { owner } = c.get("caller");
    const before = c.req.query("before");
    try {
      const { tag, catalog, page } = await openSpace(deps, owner, {
        name,
        state,
        limit: SPACE_PAGE,
        ...(before === undefined ? {} : { before }),
      });
      const images = await deps.images.imageVersions(
        owner,
        page.links.map((l) => l.id),
      );
      const done = state === "archived";
      const later = before !== undefined;
      const html = spacePage({ tag, catalog, ...page, images, now: deps.now(), done, later });
      return c.html(html, 200, NO_STORE);
    } catch (error) {
      if (!(error instanceof CoreError)) throw error;
      if (error.code === "not_found") return c.html(spaceMissingPage(), 404, NO_STORE);
      return c.html(olderInvalidPage(), 400, NO_STORE);
    }
  };
  app.get("/spaces", session, space("active"));
  app.get("/spaces/done", session, space("archived"));

  // Another owner's link, a link without an image and an id never issued all get this same 404.
  app.get(IMAGE_ROUTE, session, async (c) => {
    const image = await deps.images.image(c.get("caller").owner, c.req.param("id"));
    if (!image) return c.text("Not found.", 404, NO_STORE);
    const cached = c.req.query("v") === image.version;
    return c.body(new Uint8Array(image.bytes), 200, imageHeaders(image.contentType, cached));
  });

  app.get("/connections", session, async (c) => {
    const { owner } = c.get("caller");
    const now = (deps.now ?? (() => new Date()))();
    const page = connectionsPage({
      connections: await connections.list(owner),
      keys: keys.list(owner),
      now,
    });
    return c.html(page, 200, NO_STORE);
  });

  // Each POST's body is read, capped, before the session read takes the lock.

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
