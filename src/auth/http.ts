import { Hono } from "hono";
import { createRateLimiter, type RateLimiter, type RateLimitOptions } from "../http/rate-limit.js";
import type { WithAuthLock } from "./auth-lock.js";
import { AUTH_BASE_PATH } from "./better-auth.js";
import {
  authorizeWithOfflineAccess,
  refreshWithOfflineAccess,
  repeatsParameter,
} from "./offline-access.js";

/** The global limits that apply before the lock, each counted for everyone together. */
export type RouteLimit = "login" | "authorize" | "token" | "revoke" | "register";

/**
 * - `origin`: "same" means a POST must carry exactly the base URL's Origin, as a browser page's
 *   fetch does. "optional" lets a request without one through, for client backends; a foreign
 *   Origin is refused on every route either way.
 * - `limit`: the global limit it counts against, if any.
 * - `refuseJwksUri`: a DCR client's `jwks_uri` would be fetched with the global `fetch`, outside
 *   the guarded fetcher, so registrations naming one are refused.
 * - `gate`: authorize goes through the authorize gate instead of straight to better-auth.
 * - `offlineAccess`: where `offline_access` is added to the requested scope (`offline-access.ts`).
 */
export type RoutePolicy = {
  origin: "same" | "optional";
  limit?: RouteLimit;
  refuseJwksUri?: true;
  gate?: true;
  offlineAccess?: "query" | "form";
};

/**
 * The only better-auth endpoints the app serves, as `METHOD path` under `/api/auth`. Every other
 * request there is answered 404 before it reaches better-auth: introspection, end-session,
 * userinfo, continue, client and consent management, and every password-changing route.
 */
export const AUTH_ROUTES: ReadonlyMap<string, RoutePolicy> = new Map<string, RoutePolicy>([
  ["POST /sign-in/email", { origin: "same", limit: "login" }],
  ["POST /sign-out", { origin: "same" }],
  ["GET /get-session", { origin: "optional" }],
  [
    "GET /oauth2/authorize",
    { origin: "optional", limit: "authorize", gate: true, offlineAccess: "query" },
  ],
  ["POST /oauth2/consent", { origin: "same" }],
  ["POST /oauth2/token", { origin: "optional", limit: "token", offlineAccess: "form" }],
  ["POST /oauth2/revoke", { origin: "optional", limit: "revoke" }],
  ["POST /oauth2/register", { origin: "optional", limit: "register", refuseJwksUri: true }],
  ["GET /.well-known/oauth-authorization-server", { origin: "optional" }],
  ["HEAD /.well-known/oauth-authorization-server", { origin: "optional" }],
]);

/** The RFC 9728 and RFC 8414 documents better-auth serves at the site root. GET and HEAD only. */
export const ROOT_METADATA_PATHS = new Set([
  "/.well-known/oauth-protected-resource",
  "/.well-known/oauth-protected-resource/mcp",
  "/.well-known/oauth-authorization-server/api/auth",
]);

export const AUTH_BODY_LIMIT = 16 * 1024;

/**
 * Sign-in is limited low because it checks a password. Registration is limited low because each
 * one stores a client. Authorize, token and revoke are set high: they bound database growth and
 * load, and are not a security boundary.
 */
export const ROUTE_LIMITS: Record<RouteLimit, RateLimitOptions> = {
  login: { limit: 10, windowMs: 15 * 60_000 },
  register: { limit: 20, windowMs: 60 * 60_000 },
  authorize: { limit: 300, windowMs: 60_000 },
  token: { limit: 600, windowMs: 60_000 },
  revoke: { limit: 300, windowMs: 60_000 },
};

const TOO_MANY: Record<RouteLimit, string> = {
  login: "Too many sign-in attempts. Try again later.",
  register: "Too many client registrations. Try again later.",
  authorize: "Too many authorization requests. Try again later.",
  token: "Too many token requests. Try again later.",
  revoke: "Too many revocation requests. Try again later.",
};

export class BodyTooLarge extends Error {}

/** Reads the whole body, refusing it as soon as it passes `max` bytes, declared or streamed. */
export async function readCapped(
  request: Request,
  max: number,
): Promise<Uint8Array<ArrayBuffer> | null> {
  if (request.body === null) return null;
  if (Number(request.headers.get("content-length") ?? 0) > max) throw new BodyTooLarge();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      await reader.cancel();
      throw new BodyTooLarge();
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    body.set(c, at);
    at += c.length;
  }
  return body;
}

/** A foreign Origin is refused everywhere; a missing one only where the policy wants it. */
export function originRefused(request: Request, origin: string, policy: RoutePolicy): boolean {
  const sent = request.headers.get("origin");
  if (sent === null) return policy.origin === "same" && request.method === "POST";
  return sent !== origin;
}

const invalidOrigin = () =>
  Response.json({ code: "INVALID_ORIGIN", message: "Invalid origin." }, { status: 403 });

/** A registration body must be a JSON object without `jwks_uri`. */
function registrationRefusal(request: Request, body: Uint8Array | null): Response | null {
  const refuse = (error_description: string) =>
    Response.json({ error: "invalid_client_metadata", error_description }, { status: 400 });
  if (!/^application\/json\s*(?:;|$)/i.test(request.headers.get("content-type") ?? "")) {
    return refuse("Registration takes a JSON body.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(body ?? new Uint8Array()));
  } catch {
    return refuse("Registration takes a JSON object.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return refuse("Registration takes a JSON object.");
  }
  if (Object.hasOwn(parsed, "jwks_uri")) {
    return refuse("jwks_uri is not accepted. Use client authentication none.");
  }
  return null;
}

export function authApp({
  handle,
  withAuthLock,
  origin,
  limits = {},
  authorize,
}: {
  handle: (request: Request) => Promise<Response>;
  withAuthLock: WithAuthLock;
  origin: string;
  limits?: Partial<Record<RouteLimit, RateLimitOptions>> | undefined;
  /** Answers authorize requests; it takes the lock itself. Without it they go to better-auth. */
  authorize?: ((request: Request) => Promise<Response>) | undefined;
}) {
  const app = new Hono();
  const limiters = Object.fromEntries(
    Object.entries(ROUTE_LIMITS).map(([name, base]) => [
      name,
      createRateLimiter(limits[name as RouteLimit] ?? base),
    ]),
  ) as Record<RouteLimit, RateLimiter>;

  app.all("/*", async (c) => {
    const raw = c.req.raw;
    const { pathname } = new URL(raw.url);
    const route = `${raw.method} ${pathname.slice(AUTH_BASE_PATH.length)}`;
    const policy = pathname.startsWith(`${AUTH_BASE_PATH}/`) ? AUTH_ROUTES.get(route) : undefined;
    if (!policy) return c.json({ code: "NOT_FOUND", message: "Not found." }, 404);
    if (originRefused(raw, origin, policy)) return invalidOrigin();
    let body: Uint8Array<ArrayBuffer> | null;
    try {
      body = await readCapped(raw, AUTH_BODY_LIMIT);
    } catch (error) {
      if (!(error instanceof BodyTooLarge)) throw error;
      return c.json({ code: "PAYLOAD_TOO_LARGE", message: "Request body too large." }, 413);
    }
    if (policy.limit) {
      const verdict = limiters[policy.limit](policy.limit);
      if (!verdict.allowed) {
        return c.json({ code: "TOO_MANY_REQUESTS", message: TOO_MANY[policy.limit] }, 429, {
          "Retry-After": String(verdict.retryAfterSeconds),
        });
      }
    }
    if (policy.refuseJwksUri) {
      const refusal = registrationRefusal(raw, body);
      if (refusal) return refusal;
    }
    let url = raw.url;
    const headers = new Headers(raw.headers);
    if (policy.offlineAccess === "query") url = authorizeWithOfflineAccess(url);
    if (policy.offlineAccess === "form") {
      if (repeatsParameter(raw.headers.get("content-type"), body)) {
        return c.json(
          { error: "invalid_request", error_description: "A parameter was repeated." },
          400,
        );
      }
      const widened = refreshWithOfflineAccess(raw.headers.get("content-type"), body);
      if (widened) {
        body = widened;
        headers.delete("content-length");
      }
    }
    const request = new Request(url, { method: raw.method, headers, body });
    if (policy.gate && authorize) return authorize(request);
    return withAuthLock(() => handle(request));
  });
  return app;
}

/** The root metadata documents, served by better-auth under the lock. */
export function rootMetadataApp({
  handle,
  withAuthLock,
  origin,
}: {
  handle: (request: Request) => Promise<Response>;
  withAuthLock: WithAuthLock;
  origin: string;
}) {
  const app = new Hono();
  app.all("/*", async (c) => {
    const raw = c.req.raw;
    const { pathname } = new URL(raw.url);
    if (!["GET", "HEAD"].includes(raw.method) || !ROOT_METADATA_PATHS.has(pathname)) {
      return c.json({ code: "NOT_FOUND", message: "Not found." }, 404);
    }
    if (originRefused(raw, origin, { origin: "optional" })) return invalidOrigin();
    const request = new Request(raw.url, { method: raw.method, headers: raw.headers });
    return withAuthLock(() => handle(request));
  });
  return app;
}
