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
import { type SearchLinksDeps, searchLinks } from "../core/search-links.js";
import type { OwnerId } from "../core/types.js";
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

const isString = (value: unknown): value is string => typeof value === "string";
const isId = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;

/**
 * Takes a JSON body under the auth body cap, so any client id that can connect fits, and sets
 * `field` to its member `name` when `accepts` does.
 */
const jsonField = <T>(name: string, accepts: (value: unknown) => value is T) =>
  createMiddleware<{ Variables: { field: T } }>(async (c, next) => {
    let raw: Uint8Array | null;
    try {
      raw = await readCapped(c.req.raw, AUTH_BODY_LIMIT);
    } catch (error) {
      if (!(error instanceof BodyTooLarge)) throw error;
      return c.json({ code: "PAYLOAD_TOO_LARGE", message: "Request body too large." }, 413);
    }
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder().decode(raw ?? new Uint8Array()))[name];
    } catch {}
    if (!accepts(value)) {
      return c.json({ code: "BAD_REQUEST", message: `Send a JSON body with a ${name}.` }, 400);
    }
    c.set("field", value);
    await next();
  });

/**
 * Like `jsonField`, for a body of several members: sets `body` to the whole object when
 * `accepts` does. `wants` names the members for the refusal.
 */
const jsonBody = <T>(wants: string, accepts: (value: unknown) => value is T) =>
  createMiddleware<{ Variables: { body: T } }>(async (c, next) => {
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
    if (!accepts(value)) {
      return c.json({ code: "BAD_REQUEST", message: `Send a JSON body with ${wants}.` }, 400);
    }
    c.set("body", value);
    await next();
  });

type NoteVersion = { id: string; updatedAt: number };
const isNoteVersion = (value: unknown): value is NoteVersion =>
  typeof value === "object" &&
  value !== null &&
  isString((value as NoteVersion).id) &&
  Number.isSafeInteger((value as NoteVersion).updatedAt);
const isNoteEdit = (value: unknown): value is NoteVersion & { text: string } =>
  isNoteVersion(value) && isString((value as { text?: unknown }).text);

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

  app.get("/", session, (c) => c.html(homePage(), 200, NO_STORE));

  app.get("/search", session, async (c) => {
    const caller = c.get("caller");
    const query = c.req.query("q") ?? "";
    const links = await searchLinks(deps, caller.owner, { query }, caller.savedBy);
    const images = await deps.images.imageVersions(
      caller.owner,
      links.map((l) => l.id),
    );
    const now = (deps.now ?? (() => new Date()))();
    return c.html(searchPage({ query, links, now, images }), 200, NO_STORE);
  });

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
  app.post("/connections/disconnect", jsonField("clientId", isString), session, async (c) => {
    await connections.disconnect(c.get("caller").owner, c.get("field"));
    return c.body(null, 204, NO_STORE);
  });

  // The key is in this response only; the page shows it once and never puts it in a URL.
  app.post("/connections/keys", jsonField("name", isString), session, (c) =>
    keyAction(c, () => c.json(keys.create(c.get("caller").owner, c.get("field")), 200, NO_STORE)),
  );

  app.post("/connections/keys/turn-off", jsonField("id", isId), session, (c) =>
    keyAction(c, () => {
      keys.turnOff(c.get("caller").owner, c.get("field"));
      return c.body(null, 204, NO_STORE);
    }),
  );

  // The Undo of a turn-off.
  app.post("/connections/keys/turn-on", jsonField("id", isId), session, (c) =>
    keyAction(c, () => {
      keys.turnOn(c.get("caller").owner, c.get("field"));
      return c.body(null, 204, NO_STORE);
    }),
  );

  app.get("/profile", session, async (c) => {
    const { owner } = c.get("caller");
    const { notes, recentFocus } = await profileContext(deps, owner);
    return c.html(profilePage({ notes, focus: recentFocus, now: deps.now() }), 200, NO_STORE);
  });

  app.post("/profile/notes/add", jsonField("text", isString), session, (c) =>
    noteAction(c, () => {
      const { owner, savedBy } = c.get("caller");
      return addOwnerNote(deps, owner, savedBy, c.get("field"));
    }),
  );

  // Edit and That's right: confirming a guess is an edit with the text shown.
  for (const path of ["/profile/notes/edit", "/profile/notes/confirm"]) {
    app.post(path, jsonBody("an id, updatedAt and text", isNoteEdit), session, (c) =>
      noteAction(c, () => {
        const { owner, savedBy } = c.get("caller");
        const { id, updatedAt, text } = c.get("body");
        return editOwnerNote(deps, owner, savedBy, { id, text, updatedAt: new Date(updatedAt) });
      }),
    );
  }

  app.post("/profile/notes/remove", jsonBody("an id and updatedAt", isNoteVersion), session, (c) =>
    noteAction(c, () => {
      const { owner, savedBy } = c.get("caller");
      const { id, updatedAt } = c.get("body");
      return removeNote(deps, owner, savedBy, { id, updatedAt: new Date(updatedAt) });
    }),
  );

  // The Undo of a remove.
  app.post("/profile/notes/restore", jsonField("id", isString), session, (c) =>
    noteAction(c, () => restoreNote(deps, c.get("caller").owner, c.get("field"))),
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
