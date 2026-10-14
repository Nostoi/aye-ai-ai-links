import type { MiddlewareHandler } from "hono";

const MAX_AGENT = 200;

/**
 * One line per request: method, path, status, time, the refusal's `error` or `code` from a JSON
 * error body, and the user agent. The query string, other headers and bodies are never written:
 * they carry codes, tokens, cookies and client assertions.
 */
export function requestLog(log: (line: string) => void): MiddlewareHandler {
  return async (c, next) => {
    const start = Date.now();
    await next();
    const { status } = c.res;
    const parts = [
      "[http]",
      new Date(start).toISOString(),
      c.req.method,
      new URL(c.req.url).pathname,
      String(status),
      `${Date.now() - start}ms`,
    ];
    const error = status >= 400 ? await errorCode(c.res) : undefined;
    if (error) parts.push(`error=${error}`);
    const agent = c.req.header("user-agent");
    parts.push(`ua=${agent ? JSON.stringify(agent.slice(0, MAX_AGENT)) : "-"}`);
    try {
      log(parts.join(" "));
    } catch {}
  };
}

/** A JSON error body's `error` or `code`, if it is a plain token. Only JSON bodies are read, never a stream. */
async function errorCode(res: Response): Promise<string | undefined> {
  if (!res.headers.get("content-type")?.includes("application/json")) return undefined;
  try {
    const body: unknown = await res.clone().json();
    if (typeof body !== "object" || body === null) return undefined;
    const { error, code } = body as Record<string, unknown>;
    const value = typeof error === "string" ? error : code;
    return typeof value === "string" && /^[\w.-]{1,64}$/.test(value) ? value : undefined;
  } catch {
    return undefined;
  }
}
