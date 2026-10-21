import { createResourceServerChallenge } from "@better-auth/oauth-provider";
import { hostHeaderValidation } from "@modelcontextprotocol/hono";
import { APIError } from "better-auth/api";
import { Hono } from "hono";
import type { ChatModel } from "./ai/model.js";
import {
  createAgentKey,
  listAgentKeys,
  turnOffAgentKey,
  turnOnAgentKey,
} from "./auth/agent-keys.js";
import type { WithAuthLock } from "./auth/auth-lock.js";
import { authorizeGate } from "./auth/authorize-gate.js";
import { AUTH_BASE_PATH, type Auth, mcpResource } from "./auth/better-auth.js";
import type { Identify } from "./auth/caller.js";
import { consentDetails } from "./auth/consent.js";
import { disconnect, listConnections } from "./auth/disconnect.js";
import { authApp, originRefused, type RouteLimit, rootMetadataApp } from "./auth/http.js";
import { SAVE_PATH } from "./auth/login-return.js";
import type { MetadataStash } from "./auth/metadata-stash.js";
import type { OAuthClients } from "./auth/oauth-clients.js";
import { OAUTH_ERROR_PATH } from "./auth/oauth-error.js";
import type { ReadGate } from "./core/copy-reading.js";
import type { ExportBuilds } from "./core/export-builds.js";
import type { LinkImageReader } from "./core/image-store.js";
import type { LinkEditStore } from "./core/link-edit-store.js";
import type { SavedCopyReader, SavedCopyRemover, SavedCopyUsage } from "./core/saved-copy.js";
import type { LinkRemover } from "./core/store.js";
import type { RateLimitOptions } from "./http/rate-limit.js";
import { requestLog } from "./http/request-log.js";
import { createCallTracker } from "./mcp/call-tracker.js";
import { mcpApp } from "./mcp/http.js";
import type { McpDeps } from "./mcp/server.js";
import type { SqliteKeyStore } from "./store/key-store.js";
import {
  COPY_IMAGE_ROUTE,
  COPY_ROUTE,
  EXPORT_JSON_ROUTE,
  EXPORT_PREPARE_ROUTE,
  EXPORT_ZIP_ROUTE,
  IMAGE_ROUTE,
  webApp,
} from "./web/http.js";

/**
 * better-auth, the lock every call into it goes through, the OAuth state around it, and the
 * agent keys the web page manages.
 */
export type AuthDeps = {
  auth: Auth;
  withAuthLock: WithAuthLock;
  stash: MetadataStash;
  clients: OAuthClients;
  keys: SqliteKeyStore;
  /** Overrides of the global route limits (`ROUTE_LIMITS`), for tests. */
  limits?: Partial<Record<RouteLimit, RateLimitOptions>> | undefined;
};

/** Web pages whose Origin is checked here, before the web door. */
const CHECKED_PAGES = [
  "/",
  "/consent",
  "/connections",
  "/search",
  "/spaces",
  "/spaces/done",
  "/all",
  "/all/done",
  "/connections/disconnect",
  "/connections/keys",
  "/connections/keys/turn-off",
  "/connections/keys/turn-on",
  "/ai/chat",
  "/ai/card/:id{[0-9]+}",
  "/home/opened",
  "/home/snooze",
  "/home/unsnooze",
  "/home/archive",
  "/home/put-away",
  "/home/bring-back",
  "/home/undo-state",
  "/home/why",
  "/links/opened",
  "/links/edit",
  "/links/edit/undo",
  "/links/still-works",
  "/links/still-works/undo",
  "/links/copy/remove",
  "/links/copy/restore",
  "/links/delete",
  "/links/restore",
  "/tools/keep",
  "/tools/not-handy",
  "/tools/still-using",
  "/tools/suggestion",
  "/tools/undo",
  "/tags",
  "/tags/pin",
  "/tags/color",
  "/tags/kind",
  "/tags/status",
  "/profile",
  "/profile/notes/add",
  "/profile/notes/edit",
  "/profile/notes/confirm",
  "/profile/notes/remove",
  "/profile/notes/restore",
  SAVE_PATH,
  OAUTH_ERROR_PATH,
  IMAGE_ROUTE,
  COPY_ROUTE,
  COPY_IMAGE_ROUTE,
  EXPORT_JSON_ROUTE,
  EXPORT_ZIP_ROUTE,
  EXPORT_PREPARE_ROUTE,
];

/** The 401 challenge for `/mcp`: better-auth's, naming the RFC 9728 resource metadata. */
export function resourceChallenge(baseUrl: string): string {
  const error = createResourceServerChallenge(
    new APIError("UNAUTHORIZED", { message: "Missing or invalid access token." }),
    mcpResource(baseUrl),
  );
  const value = new Headers(error?.headers).get("www-authenticate");
  if (!value) throw new Error("better-auth gave no WWW-Authenticate challenge");
  return value;
}

export type AppOptions = {
  identify: Identify;
  allowedHosts?: string[] | undefined;
  rateLimit?: RateLimitOptions | undefined;
  /** Receives one line per request; no request log when left out. */
  log?: ((line: string) => void) | undefined;
} & (
  | { deps: McpDeps; auth?: undefined }
  /** The web door also reads stored pictures, writes the owner's edits and deletes links. */
  | {
      deps: McpDeps & {
        store: LinkRemover;
        images: LinkImageReader;
        edits: LinkEditStore;
        savedCopies: SavedCopyReader &
          SavedCopyRemover &
          Pick<SavedCopyUsage, "usedBytes" | "lastCheck">;
        copyLimitBytes?: number;
        readGate: ReadGate;
        exports: ExportBuilds;
        /** The in-app AI; `POST /ai/chat` answers NO_AI without one. */
        ai?: ChatModel | undefined;
      };
      auth: AuthDeps;
    }
);

/**
 * The whole HTTP surface. Every door is mounted here, so tests drive the real composition. The
 * server always passes `auth`; without it, as in tests of the MCP door alone, the auth routes,
 * the root metadata and the web door are not mounted. `allowedHosts` covers every door.
 * `stopTurns` aborts every in-app AI turn's model call and ends the turn at its next step; `close`
 * does the same before closing the MCP handler.
 */
export function createApp(options: AppOptions) {
  const { deps, identify, allowedHosts, rateLimit, log } = options;
  const web = options.auth ? options : undefined;
  const auth = web?.auth;
  const app = new Hono();
  // First, so refusals by every check below are recorded too.
  if (log) app.use("*", requestLog(log));
  const baseUrl = auth?.auth.options.baseURL;
  const tracker = createCallTracker();
  const turns = new AbortController();
  const stopTurns = () => turns.abort();
  const mcp = mcpApp({
    deps,
    tracker,
    identify,
    allowedHosts,
    rateLimit,
    challenge: baseUrl ? resourceChallenge(baseUrl) : undefined,
  });
  app.route("/mcp", mcp.app);
  if (web && auth && baseUrl) {
    if (allowedHosts) {
      const hosts = hostHeaderValidation(allowedHosts);
      for (const path of [`${AUTH_BASE_PATH}/*`, "/.well-known/*", "/login", ...CHECKED_PAGES]) {
        app.use(path, hosts);
      }
    }
    const origin = new URL(baseUrl).origin;
    // A foreign Origin is refused on each of these; a missing one only on their POSTs.
    for (const path of CHECKED_PAGES) {
      app.use(path, async (c, next) => {
        if (originRefused(c.req.raw, origin, { origin: "same" })) {
          return c.json({ code: "INVALID_ORIGIN", message: "Invalid origin." }, 403);
        }
        await next();
      });
    }
    const { auth: betterAuth, withAuthLock, stash, clients, keys } = auth;
    const handle = (request: Request) => betterAuth.handler(request);
    app.route(
      AUTH_BASE_PATH,
      authApp({
        handle,
        withAuthLock,
        origin,
        limits: auth.limits,
        authorize: authorizeGate({ auth: betterAuth, withAuthLock, clients, stash, handle }),
      }),
    );
    app.route("/.well-known", rootMetadataApp({ handle, withAuthLock, origin }));
    app.route(
      "/",
      webApp({
        // Owner ruling on #93: web searches aren't logged until opens are recorded.
        deps: { ...web.deps, searchLog: undefined },
        auth: betterAuth,
        withAuthLock,
        baseUrl,
        consent: consentDetails({ auth: betterAuth, withAuthLock, clients }),
        connections: {
          list: listConnections({ withAuthLock, clients }),
          disconnect: disconnect({ withAuthLock, clients, stash }),
        },
        // A key made on the web names its owner by id; an existing owner's name is kept.
        keys: {
          list: (owner) => listAgentKeys(keys, owner),
          create: (owner, name) => createAgentKey(keys, { owner, ownerName: owner, agent: name }),
          turnOff: (owner, id) => turnOffAgentKey(keys, owner, id),
          turnOn: (owner, id) => turnOnAgentKey(keys, owner, id),
        },
        // The in-app AI is an agent, so its searches are logged as through `/mcp`; the web
        // door's own searches above are not (#134).
        ai: web.deps.ai && {
          model: web.deps.ai,
          deps: web.deps,
          track: tracker.track,
          signal: turns.signal,
        },
      }),
    );
  }
  const close = async () => {
    stopTurns();
    await mcp.close();
  };
  return { app, close, stopTurns, calls: tracker.calls };
}
