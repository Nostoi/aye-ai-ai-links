import type { MiddlewareHandler } from "hono";

const MAX_AGENT = 200;
const MAX_DESCRIPTION = 200;

/**
 * One line per request. The query string, other headers and bodies are never written:
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
    const refusal = status >= 400 ? await refusalOf(c.res) : {};
    if (refusal.error) parts.push(`error=${refusal.error}`);
    if (refusal.description) parts.push(`description=${JSON.stringify(refusal.description)}`);
    const agent = c.req.header("user-agent");
    parts.push(`ua=${agent ? JSON.stringify(agent.slice(0, MAX_AGENT)) : "-"}`);
    try {
      log(parts.join(" "));
    } catch {}
  };
}

/** A JSON error body's `error` or `code` (if a plain token) and `error_description`, capped. Only JSON bodies are read, never a stream. */
async function refusalOf(res: Response): Promise<{ error?: string; description?: string }> {
  if (!res.headers.get("content-type")?.includes("application/json")) return {};
  try {
    const body: unknown = await res.clone().json();
    if (typeof body !== "object" || body === null) return {};
    const { error, code, error_description } = body as Record<string, unknown>;
    const value = typeof error === "string" ? error : code;
    return {
      error: typeof value === "string" && /^[\w.-]{1,64}$/.test(value) ? value : undefined,
      description:
        typeof error_description === "string"
          ? error_description.slice(0, MAX_DESCRIPTION)
          : undefined,
    };
  } catch {
    return {};
  }
}
