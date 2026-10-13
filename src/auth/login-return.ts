import { AUTH_BASE_PATH } from "./better-auth.js";

const AUTHORIZE_PATH = `${AUTH_BASE_PATH}/oauth2/authorize`;
// Only the origin is compared, so any fixed value works.
const PLACEHOLDER_ORIGIN = "https://login-return.invalid";

/** Where the authorize gate sends a browser without a session: the login page, told where to return. */
export const loginRedirect = (authorize: URL): string =>
  `/login?next=${encodeURIComponent(`${authorize.pathname}${authorize.search}`)}`;

/**
 * Where the login page goes after a sign-in that does not resume an authorization: the authorize
 * path and query named by `next`, or home. `next` is untrusted, so only this site's own authorize
 * path passes. Another origin, a protocol-relative URL, a `javascript:` URL and a dot segment that
 * leaves the path all resolve to something else and go home.
 */
export function returnAfterLogin(next: string | null): string {
  if (next === null) return "/";
  let url: URL;
  try {
    url = new URL(next, PLACEHOLDER_ORIGIN);
  } catch {
    return "/";
  }
  const authorize = url.origin === PLACEHOLDER_ORIGIN && url.pathname === AUTHORIZE_PATH;
  return authorize ? `${url.pathname}${url.search}` : "/";
}
