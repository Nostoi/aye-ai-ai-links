/** The scope that makes better-auth issue a refresh token. */
export const OFFLINE_ACCESS = "offline_access";

/**
 * Every app the owner approves gets a refresh token: `offline_access` is added to a request's one
 * `scope` that names others but not it. MCP clients may leave it out (ChatGPT does), and servers
 * should not ask for it, so the authorization server grants it itself (#102). It is added to
 * refreshes too, or a refresh asking for less would get a successor that never rotates (#105).
 * A missing, empty or repeated `scope` is left for better-auth to answer.
 */
function withOfflineAccess(params: URLSearchParams): URLSearchParams | null {
  const values = params.getAll("scope");
  if (values.length !== 1) return null;
  const scopes = (values[0] ?? "").split(" ").filter(Boolean);
  if (scopes.length === 0 || scopes.includes(OFFLINE_ACCESS)) return null;
  const out = new URLSearchParams(params);
  out.set("scope", [...scopes, OFFLINE_ACCESS].join(" "));
  return out;
}

/** The authorize URL with `offline_access` added, or the same URL. */
export function authorizeWithOfflineAccess(url: string): string {
  const parsed = new URL(url);
  const params = withOfflineAccess(parsed.searchParams);
  if (!params) return url;
  parsed.search = params.toString();
  return parsed.toString();
}

/** A form-encoded refresh request's body with `offline_access` added, or null to keep it. */
export function refreshWithOfflineAccess(
  contentType: string | null,
  body: Uint8Array | null,
): Uint8Array<ArrayBuffer> | null {
  if (!body || !/^application\/x-www-form-urlencoded\s*(?:;|$)/i.test(contentType ?? "")) {
    return null;
  }
  const form = new URLSearchParams(new TextDecoder().decode(body));
  if (form.get("grant_type") !== "refresh_token") return null;
  const params = withOfflineAccess(form);
  return params ? new TextEncoder().encode(params.toString()) : null;
}
