import { type Context, Hono } from "hono";
import { type OpenCodeLookup, openerOf } from "../auth/open-code.js";
import { CoreError } from "../core/errors.js";
import type { Deps } from "../core/links.js";
import { OPEN_PATH, openFromCode, openTarget } from "../core/open-codes.js";
import { createRateLimiter, type RateLimiter } from "../http/rate-limit.js";
import { OPEN_HEADERS, openMissingPage, openPage } from "./open-page.js";

/**
 * An agent's open link (#133): the page that forwards, and the page's report of the opening. Both
 * take the code alone, with no session: `openerOf` (auth) turns it into the owner, and every call
 * after it takes that owner. The origin check and host validation are `app.ts`'s, through
 * `CHECKED_PAGES`.
 */
export const OPEN_ROUTE = `${OPEN_PATH}:code`;

/** Openings recorded per code per minute; a browser sends one per click. */
export const OPEN_LIMIT = { limit: 10, windowMs: 60_000 };

const NO_STORE = { "Cache-Control": "no-store" };
const notFound = (c: Context) =>
  c.json({ code: "NOT_FOUND", message: "Not found." }, 404, NO_STORE);

/**
 * `limiter` counts only codes that were found, keyed by the code, so its keys are bounded by the
 * codes that exist; an unknown code never reaches it.
 */
export function openApp({
  deps,
  limiter = createRateLimiter(OPEN_LIMIT),
}: {
  deps: Deps & { openCodes: OpenCodeLookup };
  limiter?: RateLimiter;
}) {
  const app = new Hono();

  // Writes nothing (#95): a preview fetcher that loads it, and runs no script, records nothing.
  app.get(OPEN_ROUTE, async (c) => {
    const opener = openerOf(deps.openCodes, c.req.param("code"));
    const link = opener && (await openTarget(deps, opener));
    if (!link) return c.html(openMissingPage(), 404, OPEN_HEADERS);
    return c.html(openPage(link.url), 200, OPEN_HEADERS);
  });

  app.post(OPEN_ROUTE, async (c) => {
    const code = c.req.param("code");
    const opener = openerOf(deps.openCodes, code);
    if (!opener) return notFound(c);
    const verdict = limiter(code);
    if (!verdict.allowed) {
      return c.json(
        { code: "TOO_MANY_REQUESTS", message: "Too many openings of this link. Try again later." },
        429,
        { ...NO_STORE, "Retry-After": String(verdict.retryAfterSeconds) },
      );
    }
    try {
      await openFromCode(deps, opener);
    } catch (error) {
      if (error instanceof CoreError && error.code === "not_found") return notFound(c);
      throw error;
    }
    return c.body(null, 204, NO_STORE);
  });

  return app;
}
