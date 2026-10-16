import { OAUTH_ERROR_PATH } from "./oauth-error.js";

const JSON_TYPE = /^application\/([a-z0-9.+-]*\+)?json/i;

/**
 * Whether a sign-in body carries `oauth_query`, which makes better-auth resume an authorization.
 * Sign-in takes a JSON or a form body, and both are read here as better-auth reads them.
 */
export function carriesOAuthQuery(request: Request, body: Uint8Array | null): boolean {
  if (body === null) return false;
  const type = request.headers.get("content-type") ?? "";
  const text = new TextDecoder().decode(body);
  if (JSON_TYPE.test(type)) {
    try {
      const parsed: unknown = JSON.parse(text);
      return (
        typeof parsed === "object" &&
        parsed !== null &&
        Boolean((parsed as Record<string, unknown>).oauth_query)
      );
    } catch {
      return false;
    }
  }
  if (/application\/x-www-form-urlencoded/i.test(type)) {
    return Boolean(new URLSearchParams(text).get("oauth_query"));
  }
  return false;
}

/**
 * A resumed sign-in that better-auth refuses with an OAuth error (a JSON body with a string
 * `error`) becomes the answer it gives for its other authorize refusals: `{redirect, url}` to the
 * error page, which shows only our own sentence. The error code goes along, its description does
 * not, and every header but the body's length is kept, so a session the sign-in made stays.
 * A bad password carries `code`, not `error`, and stays as it is. Returns null, leaving the
 * response unread, when it is not such a refusal.
 */
export async function resumedRefusal(
  response: Response,
): Promise<{ response: Response; error: string } | null> {
  if (response.status < 400 || !JSON_TYPE.test(response.headers.get("content-type") ?? "")) {
    return null;
  }
  let error: unknown;
  try {
    const body: unknown = await response.clone().json();
    error =
      typeof body === "object" && body !== null
        ? (body as Record<string, unknown>).error
        : undefined;
  } catch {
    return null;
  }
  if (typeof error !== "string") return null;
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  const url = `${OAUTH_ERROR_PATH}?error=${encodeURIComponent(error)}`;
  return { response: Response.json({ redirect: true, url }, { status: 200, headers }), error };
}
