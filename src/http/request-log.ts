import type { MiddlewareHandler } from "hono";

const MAX_AGENT = 200;
const MAX_DESCRIPTION = 200;

/**
 * The context key a door sets to the error code of a refusal it answers with a success status,
 * so the line still records the code. Never a description.
 */
export const LOGGED_REFUSAL = "loggedRefusal";

declare module "hono" {
  interface ContextVariableMap {
    [LOGGED_REFUSAL]: string;
  }
}

const plainToken = (value: unknown) =>
  typeof value === "string" && /^[\w.-]{1,64}$/.test(value) ? value : undefined;

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
    const error = refusal.error ?? plainToken(c.get(LOGGED_REFUSAL));
    if (error) parts.push(`error=${error}`);
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
    return {
      error: plainToken(typeof error === "string" ? error : code),
      description:
        typeof error_description === "string"
          ? error_description.slice(0, MAX_DESCRIPTION)
          : undefined,
    };
  } catch {
    return {};
  }
}
