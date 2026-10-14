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

const FORM_TYPE = /^application\/x-www-form-urlencoded\s*(?:;|$)/i;

/** What the token route forwards: the form re-encoded, or the refusal to send back. */
export type TokenForm =
  | { body: Uint8Array<ArrayBuffer> }
  | { status: 400 | 415; description: string };

/** Parses a token request's body once and re-encodes it, so better-auth reads only what was checked. */
export function tokenForm(contentType: string | null, body: Uint8Array | null): TokenForm {
  if (!FORM_TYPE.test(contentType ?? "")) {
    return { status: 415, description: "The body must be application/x-www-form-urlencoded." };
  }
  const form = new URLSearchParams(body ? new TextDecoder().decode(body) : "");
  const names = [...form.keys()];
  if (new Set(names).size !== names.length) {
    return { status: 400, description: "A parameter was repeated." };
  }
  const widened = form.get("grant_type") === "refresh_token" ? withOfflineAccess(form) : null;
  return { body: new TextEncoder().encode((widened ?? form).toString()) };
}
