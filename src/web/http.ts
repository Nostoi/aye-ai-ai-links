import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import type { WithAuthLock } from "../auth/auth-lock.js";
import type { Auth } from "../auth/better-auth.js";
import type { ConsentDetails } from "../auth/consent.js";
import { AUTH_BODY_LIMIT, BodyTooLarge, readCapped } from "../auth/http.js";
import { returnAfterLogin } from "../auth/login-return.js";
import { OAUTH_ERROR_PATH, oauthErrorMessage } from "../auth/oauth-error.js";
import { type SearchLinksDeps, searchLinks } from "../core/search-links.js";
import type { OwnerId } from "../core/types.js";
import {
  type ConnectionRow,
  connectionsPage,
  consentExpiredPage,
  consentPage,
  homePage,
  loginPage,
  oauthErrorPage,
} from "./pages.js";
import { requireSession, type SessionEnv } from "./require-session.js";

/** Pages show one person's data, so no browser or proxy may keep a copy. */
const NO_STORE = { "Cache-Control": "no-store" };

/** Takes a JSON `{clientId}` body under the auth body cap, so any id that can connect fits. */
const clientIdBody = createMiddleware<{ Variables: { clientId: string } }>(async (c, next) => {
  let raw: Uint8Array | null;
  try {
    raw = await readCapped(c.req.raw, AUTH_BODY_LIMIT);
  } catch (error) {
    if (!(error instanceof BodyTooLarge)) throw error;
    return c.json({ code: "PAYLOAD_TOO_LARGE", message: "Request body too large." }, 413);
  }
  let clientId: unknown;
  try {
    clientId = JSON.parse(new TextDecoder().decode(raw ?? new Uint8Array())).clientId;
  } catch {}
  if (typeof clientId !== "string") {
    return c.json({ code: "BAD_REQUEST", message: "Send a JSON body with a clientId." }, 400);
  }
  c.set("clientId", clientId);
  await next();
});

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
    const caller = c.get("caller");
    const links = await searchLinks(deps, caller.owner, { query: "" }, caller.savedBy);
    return c.html(homePage(links), 200, NO_STORE);
  });

  app.get("/connections", session, async (c) =>
    c.html(connectionsPage(await connections.list(c.get("caller").owner)), 200, NO_STORE),
  );

  // The body is read, capped, before the session read takes the lock. 204 whether or not the app
  // was connected; the page reloads either way.
  app.post("/connections/disconnect", clientIdBody, session, async (c) => {
    await connections.disconnect(c.get("caller").owner, c.get("clientId"));
    return c.body(null, 204, NO_STORE);
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
