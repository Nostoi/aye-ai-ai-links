import { type Context, Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { AgentKeyError } from "../auth/agent-keys.js";
import type { WithAuthLock } from "../auth/auth-lock.js";
import type { Auth } from "../auth/better-auth.js";
import type { ConsentDetails } from "../auth/consent.js";
import { AUTH_BODY_LIMIT, BodyTooLarge, readCapped } from "../auth/http.js";
import { returnAfterLogin } from "../auth/login-return.js";
import { OAUTH_ERROR_PATH, oauthErrorMessage } from "../auth/oauth-error.js";
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
import { requireSession, type SessionEnv } from "./require-session.js";

/** Pages show one person's data, so no browser or proxy may keep a copy. */
const NO_STORE = { "Cache-Control": "no-store" };

type Check<T> = (value: unknown) => value is T;
const isString: Check<string> = (value) => typeof value === "string";
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
  deps: SearchLinksDeps;
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
    const now = (deps.now ?? (() => new Date()))();
    return c.html(searchPage({ query, links, now }), 200, NO_STORE);
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
