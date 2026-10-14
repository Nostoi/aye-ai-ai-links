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
import { type SearchLinksDeps, searchLinks } from "../core/search-links.js";
import type { OwnerId } from "../core/types.js";
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
import { type ConnectionRow, connectionsPage } from "./connections-page.js";
import { homePage } from "./home-page.js";
import { consentExpiredPage, consentPage, loginPage, oauthErrorPage, searchPage } from "./pages.js";
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

/** A link id as the page sends it: digits, as the store issues them. */
const isLinkId = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9]{1,20}$/.test(value);
const isDate = (value: unknown): value is string =>
  typeof value === "string" && !Number.isNaN(Date.parse(value));

/**
 * Reads a JSON body under the auth body cap, so any client id that can connect fits. Returns the
 * parsed body (undefined when it is not JSON), or the 413 to answer with.
 */
async function readJson(c: Context): Promise<{ body: unknown } | Response> {
  let raw: Uint8Array | null;
  try {
    raw = await readCapped(c.req.raw, AUTH_BODY_LIMIT);
  } catch (error) {
    if (!(error instanceof BodyTooLarge)) throw error;
    return c.json({ code: "PAYLOAD_TOO_LARGE", message: "Request body too large." }, 413);
  }
  try {
    return { body: JSON.parse(new TextDecoder().decode(raw ?? new Uint8Array())) };
  } catch {
    return { body: undefined };
  }
}

const member = (body: unknown, name: string): unknown =>
  typeof body === "object" && body !== null ? (body as Record<string, unknown>)[name] : undefined;

/** Takes a JSON body (see `readJson`) and sets `field` to its member `name` when `accepts` does. */
const jsonField = <T>(name: string, accepts: (value: unknown) => value is T) =>
  createMiddleware<{ Variables: { field: T } }>(async (c, next) => {
    const read = await readJson(c);
    if (read instanceof Response) return read;
    const value = member(read.body, name);
    if (!accepts(value)) {
      return c.json({ code: "BAD_REQUEST", message: `Send a JSON body with a ${name}.` }, 400);
    }
    c.set("field", value);
    await next();
  });

/** `jsonField` for two members: sets `fields` to both when each is accepted. */
const jsonFields = <A, B>(
  [nameA, acceptsA]: [string, (value: unknown) => value is A],
  [nameB, acceptsB]: [string, (value: unknown) => value is B],
) =>
  createMiddleware<{ Variables: { fields: [A, B] } }>(async (c, next) => {
    const read = await readJson(c);
    if (read instanceof Response) return read;
    const [a, b] = [member(read.body, nameA), member(read.body, nameB)];
    if (!acceptsA(a) || !acceptsB(b)) {
      return c.json(
        { code: "BAD_REQUEST", message: `Send a JSON body with a ${nameA} and a ${nameB}.` },
        400,
      );
    }
    c.set("fields", [a, b]);
    await next();
  });

/** The page's words for a link that is gone; core's are written for an agent. */
const LINK_GONE = "That link is gone. Reload the page.";
const HOME_REFUSALS = { not_found: 404, conflict: 409, invalid_input: 400 } as const;

/** A refused home action answers with its status and message; anything else is thrown on. */
async function homeAction(c: Context, act: () => Promise<Response>): Promise<Response> {
  try {
    return await act();
  } catch (error) {
    if (!(error instanceof CoreError) || !(error.code in HOME_REFUSALS)) throw error;
    const code = error.code as keyof typeof HOME_REFUSALS;
    const message = code === "not_found" ? LINK_GONE : error.message;
    return c.json({ code, message }, HOME_REFUSALS[code], NO_STORE);
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
  deps: SearchLinksDeps & WorthDeps & { images: LinkImageReader };
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

  // Reads only: a cross-site GET carries the Lax session cookie, so it must not use links up.
  app.get("/", session, async (c) => {
    const { owner } = c.get("caller");
    const links = await worthALook(deps, owner);
    const images = await deps.images.imageVersions(
      owner,
      links.map((d) => d.link.id),
    );
    const page = homePage({ worth: { links, images, now: deps.now() }, spaces: "" });
    return c.html(page, 200, NO_STORE);
  });

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

  // The home cards' buttons. Recording an opening is a POST, never a redirect route: a GET that
  // writes could be set off from another site.
  const linkId = jsonField("id", isLinkId);
  const done = (c: Context) => c.body(null, 204, NO_STORE);

  app.post("/home/opened", linkId, session, (c) =>
    homeAction(c, async () => {
      await markOpened(deps, c.get("caller").owner, c.get("field"));
      return done(c);
    }),
  );

  // Answers when the snooze ends, which its Undo sends back.
  app.post("/home/snooze", linkId, session, (c) =>
    homeAction(c, async () => {
      const until = await snoozeLink(deps, c.get("caller").owner, c.get("field"));
      return c.json({ until: until.toISOString() }, 200, NO_STORE);
    }),
  );

  app.post("/home/unsnooze", jsonFields(["id", isLinkId], ["until", isDate]), session, (c) =>
    homeAction(c, async () => {
      const [id, until] = c.get("fields");
      await unsnoozeLink(deps, c.get("caller").owner, id, new Date(until));
      return done(c);
    }),
  );

  app.post("/home/archive", linkId, session, (c) =>
    homeAction(c, async () => {
      await archiveLink(deps, c.get("caller").owner, c.get("field"));
      return done(c);
    }),
  );

  app.post("/home/unarchive", linkId, session, (c) =>
    homeAction(c, async () => {
      await unarchiveLink(deps, c.get("caller").owner, c.get("field"));
      return done(c);
    }),
  );

  app.post("/home/why", jsonFields(["id", isLinkId], ["text", isString]), session, (c) =>
    homeAction(c, async () => {
      const [id, text] = c.get("fields");
      await tellWhy(deps, c.get("caller").owner, id, text);
      return done(c);
    }),
  );

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
