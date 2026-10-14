import type { WithAuthLock } from "./auth-lock.js";
import type { Auth } from "./better-auth.js";
import type { Caller, Identify } from "./caller.js";

/** What a browser session records as `savedBy` and `writtenBy`: the owner's own writes. */
export const WEB_SAVED_BY = "web";

/** Whether a writer's name would pass for the web session's; no agent or app may use it. */
export const namesWeb = (name: string) => name.trim().toLowerCase() === WEB_SAVED_BY;

/**
 * Reads the request's session from the database, under the auth lock: `getSession` can refresh
 * or delete a session, so it is a write. `headers` holds any `Set-Cookie` the caller must
 * forward, such as a refreshed session cookie.
 */
export async function readSession(
  auth: Auth,
  withAuthLock: WithAuthLock,
  requestHeaders: Headers,
): Promise<{ caller: Caller | null; headers: Headers }> {
  const { response, headers } = await withAuthLock(() =>
    auth.api.getSession({ headers: requestHeaders, returnHeaders: true }),
  );
  const caller = response ? { owner: response.user.id, savedBy: WEB_SAVED_BY } : null;
  return { caller, headers };
}

/** The session's owner as a caller, or null; for doors that need no cookie forwarded. */
export const sessionIdentify =
  (auth: Auth, withAuthLock: WithAuthLock): Identify =>
  async (request) => {
    const { caller } = await readSession(auth, withAuthLock, request.headers);
    return caller && { ...caller, rateKey: `session:${caller.owner}` };
  };
