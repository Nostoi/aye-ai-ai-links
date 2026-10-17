import { AUTH_BASE_PATH } from "./better-auth.js";

const AUTHORIZE_PATH = `${AUTH_BASE_PATH}/oauth2/authorize`;
/** The Save page's path (#129): the bookmarklet opens it, and sign-in may return to it. */
export const SAVE_PATH = "/save";
// Only the origin is compared, so any fixed value works.
const PLACEHOLDER_ORIGIN = "https://login-return.invalid";

/**
 * Where a browser without a session is sent: the login page, told where to return. The authorize
 * gate sends its authorize query here, and the Save page its own address (#129).
 */
export const loginRedirect = (back: URL): string =>
  `/login?next=${encodeURIComponent(`${back.pathname}${back.search}`)}`;

/**
 * Where the login page goes after a sign-in that does not resume an authorization. `next` is
 * untrusted, so only two of this site's paths pass:
 * - the authorize path, with its query as sent;
 * - the Save page, rebuilt with only its first `url` and `title`, so nothing else rides along.
 * Anything else goes home: another origin, a protocol-relative URL, a `javascript:` URL, a dot
 * segment that resolves to another path, and any other spelling of either path.
 */
export function returnAfterLogin(next: string | null): string {
  if (next === null) return "/";
  let url: URL;
  try {
    url = new URL(next, PLACEHOLDER_ORIGIN);
  } catch {
    return "/";
  }
  if (url.origin !== PLACEHOLDER_ORIGIN) return "/";
  if (url.pathname === AUTHORIZE_PATH) return `${url.pathname}${url.search}`;
  if (url.pathname === SAVE_PATH) return saveReturn(url.searchParams);
  return "/";
}

/** The Save page's address with only its first `url` and `title`, each kept only when present. */
function saveReturn(query: URLSearchParams): string {
  const kept = new URLSearchParams();
  for (const name of ["url", "title"]) {
    const value = query.get(name);
    if (value !== null) kept.set(name, value);
  }
  const search = kept.toString();
  return search === "" ? SAVE_PATH : `${SAVE_PATH}?${search}`;
}
