import { Hono } from "hono";
import type { WithAuthLock } from "../auth/auth-lock.js";
import type { Auth } from "../auth/better-auth.js";
import type { ConsentDetails } from "../auth/consent.js";
import { type SearchLinksDeps, searchLinks } from "../core/search-links.js";
import { consentExpiredPage, consentPage, homePage, loginPage } from "./pages.js";
import { requireSession, type SessionEnv } from "./require-session.js";

/** Pages show one person's data, so no browser or proxy may keep a copy. */
const NO_STORE = { "Cache-Control": "no-store" };

/** The web door. `/login` is the only page served without a session. */
export function webApp({
  deps,
  auth,
  withAuthLock,
  consent,
}: {
  deps: SearchLinksDeps;
  auth: Auth;
  withAuthLock: WithAuthLock;
  /** What to show for a signed authorize query; without it there is no consent page. */
  consent?: ((query: string) => Promise<ConsentDetails | null>) | undefined;
}) {
  const app = new Hono<SessionEnv>();
  const session = requireSession(auth, withAuthLock);

  app.get("/login", (c) => c.html(loginPage(), 200, NO_STORE));

  app.get("/", session, async (c) => {
    const caller = c.get("caller");
    const links = await searchLinks(deps, caller.owner, { query: "" }, caller.savedBy);
    return c.html(homePage(links), 200, NO_STORE);
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
