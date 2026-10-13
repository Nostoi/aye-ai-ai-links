import { Hono } from "hono";
import { createRateLimiter, type RateLimitOptions } from "../http/rate-limit.js";
import type { WithAuthLock } from "./auth-lock.js";
import { AUTH_BASE_PATH } from "./better-auth.js";

/**
 * The only better-auth endpoints the app serves, as `METHOD path` under `/api/auth`. Every other
 * request there is answered 404 before it reaches better-auth, so no password-changing or
 * password-checking route is reachable except `/sign-in/email`, which the login limit covers.
 */
export const AUTH_ROUTES = new Set(["POST /sign-in/email", "POST /sign-out", "GET /get-session"]);

/** The routes that check a password, and so count against the global login limit. */
const LOGIN_ROUTES = new Set(["POST /sign-in/email"]);

export const AUTH_BODY_LIMIT = 16 * 1024;

/** 10 sign-in attempts per 15 minutes, for everyone together. */
const LOGIN_LIMIT: RateLimitOptions = { limit: 10, windowMs: 15 * 60_000 };

class BodyTooLarge extends Error {}

/** Reads the whole body, refusing it as soon as it passes `max` bytes, declared or streamed. */
async function readCapped(request: Request, max: number): Promise<Uint8Array<ArrayBuffer> | null> {
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

export function authApp({
  handle,
  withAuthLock,
  origin,
  loginLimit = LOGIN_LIMIT,
}: {
  handle: (request: Request) => Promise<Response>;
  withAuthLock: WithAuthLock;
  origin: string;
  loginLimit?: RateLimitOptions | undefined;
}) {
  const app = new Hono();
  const limiter = createRateLimiter(loginLimit);

  app.all("/*", async (c) => {
    const raw = c.req.raw;
    const { pathname } = new URL(raw.url);
    const route = `${raw.method} ${pathname.slice(AUTH_BASE_PATH.length)}`;
    if (!pathname.startsWith(`${AUTH_BASE_PATH}/`) || !AUTH_ROUTES.has(route)) {
      return c.json({ code: "NOT_FOUND", message: "Not found." }, 404);
    }
    if (raw.method === "POST" && raw.headers.get("origin") !== origin) {
      return c.json({ code: "INVALID_ORIGIN", message: "Invalid origin." }, 403);
    }
    let body: Uint8Array<ArrayBuffer> | null;
    try {
      body = await readCapped(raw, AUTH_BODY_LIMIT);
    } catch (error) {
      if (!(error instanceof BodyTooLarge)) throw error;
      return c.json({ code: "PAYLOAD_TOO_LARGE", message: "Request body too large." }, 413);
    }
    if (LOGIN_ROUTES.has(route)) {
      const verdict = limiter("login");
      if (!verdict.allowed) {
        return c.json(
          { code: "TOO_MANY_REQUESTS", message: "Too many sign-in attempts. Try again later." },
          429,
          { "Retry-After": String(verdict.retryAfterSeconds) },
        );
      }
    }
    const request = new Request(raw.url, { method: raw.method, headers: raw.headers, body });
    return withAuthLock(() => handle(request));
  });
  return app;
}
