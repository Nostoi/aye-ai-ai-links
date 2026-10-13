import { createMiddleware } from "hono/factory";
import type { WithAuthLock } from "../auth/auth-lock.js";
import type { Auth } from "../auth/better-auth.js";
import type { Caller } from "../auth/caller.js";
import { readSession } from "../auth/session.js";

export type SessionEnv = { Variables: { caller: Caller } };

/**
 * Lets a request through only with a live session, and sets its `caller`. Without one it
 * redirects to `/login`. Either way it forwards any `Set-Cookie` that reading the session set.
 */
export const requireSession = (auth: Auth, withAuthLock: WithAuthLock) =>
  createMiddleware<SessionEnv>(async (c, next) => {
    const { caller, headers } = await readSession(auth, withAuthLock, c.req.raw.headers);
    const cookies = headers.getSetCookie();
    if (!caller) {
      const res = c.redirect("/login", 302);
      res.headers.set("Cache-Control", "no-store");
      for (const cookie of cookies) res.headers.append("Set-Cookie", cookie);
      return res;
    }
    c.set("caller", caller);
    await next();
    for (const cookie of cookies) c.res.headers.append("Set-Cookie", cookie);
  });
