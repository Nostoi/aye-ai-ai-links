import {
  createHash,
  generateKeyPairSync,
  type KeyObject,
  randomBytes,
  randomUUID,
  sign,
} from "node:crypto";
import type Database from "better-sqlite3";
import { createApp } from "../app.js";
import { createDeps } from "../deps.js";
import type { RateLimitOptions } from "../http/rate-limit.js";
import { FakeEmbedder } from "../search/embedder.js";
import { DIMS } from "../search/model.js";
import { openDatabase } from "../store/database.js";
import { SqliteKeyStore } from "../store/key-store.js";
import { SqliteStore } from "../store/sqlite-store.js";
import { keyIdentify } from "./agent-keys.js";
import { insideAuthLock } from "./auth-lock.js";
import { mcpResource } from "./better-auth.js";
import type { RouteLimit } from "./http.js";
import { memoryAuth, TEST_BASE_URL, TEST_EMAIL, TEST_PASSWORD } from "./memory-auth.js";
import type { JsonFetch } from "./metadata-stash.js";

/** For tests: scripted OAuth clients and the network they publish their metadata on. */

export const RESOURCE = mcpResource(TEST_BASE_URL);
export const TOKEN_URL = `${TEST_BASE_URL}/api/auth/oauth2/token`;

export const CLAUDE_ID = "https://claude.ai/oauth/mcp-oauth-client-metadata";
export const CLAUDE_REDIRECT = "https://claude.ai/api/mcp/auth_callback";
export const claudeDocument = {
  client_id: CLAUDE_ID,
  client_name: "Claude",
  redirect_uris: [CLAUDE_REDIRECT],
  grant_types: ["authorization_code", "refresh_token"],
  response_types: ["code"],
  token_endpoint_auth_method: "none",
};

export const CHATGPT_ID = "https://chatgpt.com/oauth/test-client/metadata.json";
export const CHATGPT_REDIRECT = "https://chatgpt.com/connector_platform_oauth_redirect";
export const chatgptDocument = (jwksUri: string) => ({
  client_id: CHATGPT_ID,
  client_name: "ChatGPT",
  redirect_uris: [CHATGPT_REDIRECT],
  grant_types: ["authorization_code", "refresh_token"],
  response_types: ["code"],
  token_endpoint_auth_method: "private_key_jwt",
  jwks_uri: jwksUri,
});

export const DCR_REDIRECT = "https://dcr-client.example/callback";

/** Another CIMD client, the `i`th, with no client secret. */
export function otherClientDocument(i: number) {
  const id = `https://client${i}.example/oauth/metadata.json`;
  const redirect = `https://client${i}.example/cb`;
  const document = {
    client_id: id,
    client_name: `Client ${i}`,
    redirect_uris: [redirect],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  };
  return { id, redirect, document };
}

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

/** A P-256 key, its public JWK, and ES256 signing. */
export function signingKey(kid: string) {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid, alg: "ES256", use: "sig" };
  return { kid, privateKey, jwk };
}

function jwt(header: object, claims: object, key: KeyObject) {
  const input = `${b64(header)}.${b64(claims)}`;
  const signature = sign("sha256", Buffer.from(input), { key, dsaEncoding: "ieee-p1363" });
  return `${input}.${signature.toString("base64url")}`;
}

/** An RFC 7523 client assertion, as ChatGPT sends for `private_key_jwt`. */
export function clientAssertion(key: ReturnType<typeof signingKey>, clientId: string) {
  const now = Math.floor(Date.now() / 1000);
  return jwt(
    { alg: "ES256", kid: key.kid, typ: "JWT" },
    { iss: clientId, sub: clientId, aud: TOKEN_URL, jti: randomUUID(), iat: now, exp: now + 60 },
    key.privateKey,
  );
}

/** An RFC 9449 DPoP proof for a POST to `url`. */
export function dpopProof(key: ReturnType<typeof signingKey>, url: string) {
  const { kid: _, alg: __, use: ___, ...publicJwk } = key.jwk;
  return jwt(
    { alg: "ES256", typ: "dpop+jwt", jwk: publicJwk },
    { htm: "POST", htu: url, iat: Math.floor(Date.now() / 1000), jti: randomUUID() },
    key.privateKey,
  );
}

export function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

type Route = (headers: Record<string, string>) => Response | Promise<Response>;

/** The internet as client metadata hosts see it. Every fetch is recorded, with whether it ran under the auth lock. */
export function fakeNetwork() {
  const routes = new Map<string, Route>();
  const calls: { url: string; locked: boolean; headers: Record<string, string> }[] = [];
  const fetch: JsonFetch = async (url, init) => {
    calls.push({ url, locked: insideAuthLock(), headers: init.headers });
    init.signal.throwIfAborted();
    const route = routes.get(url);
    return route ? route(init.headers) : new Response("not found", { status: 404 });
  };
  return {
    fetch,
    calls,
    route: (url: string, route: Route) => routes.set(url, route),
    json: (url: string, body: unknown, headers: Record<string, string> = {}) =>
      routes.set(url, () => Response.json(body, { headers })),
    status: (url: string, status: number) => routes.set(url, () => new Response("", { status })),
  };
}

export type Sent = {
  status: number;
  headers: Headers;
  body: Record<string, unknown> | string;
  /** The response body exactly as sent. */
  bytes: Buffer;
};

/** A browser or a client backend: keeps cookies, and sends the base Origin on POSTs unless told not to. */
export class Agent {
  readonly cookies = new Map<string, string>();
  constructor(private readonly app: { fetch: (r: Request) => Response | Promise<Response> }) {}

  async send(
    path: string,
    {
      method = "GET",
      headers = {},
      json,
      form,
      rawForm,
      multipart,
      origin = method === "POST",
    }: {
      method?: string;
      headers?: Record<string, string>;
      json?: unknown;
      form?: Record<string, string>;
      /** A form body sent as written, for names a record cannot repeat; a `content-type` header is kept. */
      rawForm?: string;
      /** A multipart form; its boundary header comes from the body. */
      multipart?: FormData;
      origin?: boolean;
    } = {},
  ): Promise<Sent> {
    const h = new Headers(headers);
    let body: string | FormData | undefined;
    if (json !== undefined) {
      h.set("content-type", "application/json");
      body = JSON.stringify(json);
    }
    if (form) {
      h.set("content-type", "application/x-www-form-urlencoded");
      body = new URLSearchParams(form).toString();
    }
    if (rawForm !== undefined) {
      if (!h.has("content-type")) h.set("content-type", "application/x-www-form-urlencoded");
      body = rawForm;
    }
    if (multipart) body = multipart;
    if (origin && !h.has("origin")) h.set("origin", TEST_BASE_URL);
    if (this.cookies.size > 0 && !h.has("cookie")) {
      h.set("cookie", [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "));
    }
    const url = path.startsWith("http") ? path : `${TEST_BASE_URL}${path}`;
    if (!h.has("host")) h.set("host", new URL(url).host);
    const res = await this.app.fetch(new Request(url, { method, headers: h, body }));
    for (const cookie of res.headers.getSetCookie()) {
      const [pair = ""] = cookie.split(";");
      const at = pair.indexOf("=");
      const value = pair.slice(at + 1);
      if (value === "" || /max-age=0/i.test(cookie)) this.cookies.delete(pair.slice(0, at));
      else this.cookies.set(pair.slice(0, at), value);
    }
    const bytes = Buffer.from(await res.arrayBuffer());
    const text = bytes.toString("utf8");
    let parsed: Record<string, unknown> | string = text;
    try {
      parsed = JSON.parse(text);
    } catch {}
    return { status: res.status, headers: res.headers, body: parsed, bytes };
  }

  async signIn(extra: Record<string, unknown> = {}) {
    return this.send("/api/auth/sign-in/email", {
      method: "POST",
      json: { email: TEST_EMAIL, password: TEST_PASSWORD, ...extra },
    });
  }
}

export const field = (sent: Sent, name: string): string => {
  const value = typeof sent.body === "object" ? sent.body[name] : undefined;
  if (typeof value !== "string") throw new Error(`no ${name} in ${JSON.stringify(sent.body)}`);
  return value;
};

/** The app with OAuth and agent keys, as the server composes it, over a fake metadata network. */
export async function oauthWorld({
  now,
  rateLimit,
  limits,
  authDb,
  net = fakeNetwork(),
  log,
  savedCopyDir,
  copyLimitBytes = 0,
}: {
  now?: () => number;
  rateLimit?: { limit: number; now: () => number };
  limits?: Partial<Record<RouteLimit, RateLimitOptions>>;
  /** The auth database; in memory when left out. */
  authDb?: Database.Database;
  net?: ReturnType<typeof fakeNetwork>;
  log?: (line: string) => void;
  /** A folder for saved copies; without it, copies read as missing and none are written. */
  savedCopyDir?: string;
  /** The saved-copy limit the web door shows on All links; 0 shows no line. */
  copyLimitBytes?: number;
} = {}) {
  const links = openDatabase(":memory:");
  const keyStore = new SqliteKeyStore(links);
  const auth = await memoryAuth({
    fetch: net.fetch,
    keys: keyIdentify(keyStore),
    ...(now && { now }),
    ...(authDb && { db: authDb }),
  });
  const deps = createDeps(links, new FakeEmbedder(DIMS), savedCopyDir ?? null);
  if (savedCopyDir !== undefined) {
    const folder = await deps.savedCopies.checkFolder();
    if (folder.state !== "ready")
      throw new Error(`The saved-copy folder is not ready: ${folder.detail}`);
  }
  deps.store.ensureUser("owner", "Owner");
  const { app } = createApp({
    deps: { ...deps, copyLimitBytes },
    identify: auth.identify,
    auth: { ...auth, keys: keyStore, limits },
    allowedHosts: ["links.example"],
    rateLimit,
    log,
  });
  const savedBy = () =>
    (links.prepare("SELECT saved_by AS s FROM links ORDER BY rowid").all() as { s: string }[]).map(
      (r) => r.s,
    );
  return {
    ...auth,
    net,
    app,
    links,
    keyStore,
    savedCopies: deps.savedCopies,
    savedBy,
    agent: () => new Agent(app),
  };
}

export type World = Awaited<ReturnType<typeof oauthWorld>>;

export function authorizePath(
  clientId: string,
  redirectUri: string,
  challenge: string,
  overrides: Record<string, string> = {},
) {
  const query = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: "links offline_access",
    state: "st-1",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: RESOURCE,
    ...overrides,
  });
  return `/api/auth/oauth2/authorize?${query}`;
}

/**
 * The browser half of a first connection: authorize with no session, the app's redirect to
 * login, sign-in, back to authorize, the consent page, and Allow. Returns the code.
 */
export async function approve(
  world: World,
  clientId: string,
  redirectUri: string,
  { browser = world.agent(), challenge = pkce().challenge, scope = "links offline_access" } = {},
) {
  const start = await browser.send(authorizePath(clientId, redirectUri, challenge, { scope }));
  if (start.status !== 302) throw new Error(`authorize gave ${start.status}`);
  const login = new URL(start.headers.get("location") ?? "", TEST_BASE_URL);
  if (login.pathname !== "/login") throw new Error(`authorize went to ${login.pathname}`);
  const next = login.searchParams.get("next") ?? "";
  if ((await browser.signIn()).status !== 200) throw new Error("sign-in failed");
  const again = await browser.send(next);
  const consent = new URL(again.headers.get("location") ?? "", TEST_BASE_URL);
  if (again.status !== 302 || consent.pathname !== "/consent") {
    throw new Error(`authorize after sign-in gave ${again.status} ${JSON.stringify(again.body)}`);
  }
  const page = await browser.send(`${consent.pathname}${consent.search}`);
  if (page.status !== 200) throw new Error(`the consent page gave ${page.status}`);
  const accepted = await browser.send("/api/auth/oauth2/consent", {
    method: "POST",
    json: { accept: true, oauth_query: consent.search.slice(1) },
  });
  const back = new URL(field(accepted, "url"));
  const code = back.searchParams.get("code");
  if (!code) throw new Error(`consent gave no code: ${back}`);
  return { code, page, back, browser, consentQuery: consent.search.slice(1) };
}

/** The client backend's code exchange: no cookie, no Origin. */
export async function exchange(
  world: World,
  code: string,
  verifier: string,
  form: Record<string, string>,
) {
  return world.agent().send("/api/auth/oauth2/token", {
    method: "POST",
    origin: false,
    form: {
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      resource: RESOURCE,
      ...form,
    },
  });
}

export async function refresh(world: World, refreshToken: string, form: Record<string, string>) {
  return world.agent().send("/api/auth/oauth2/token", {
    method: "POST",
    origin: false,
    form: { grant_type: "refresh_token", refresh_token: refreshToken, resource: RESOURCE, ...form },
  });
}

let rpcId = 0;
/** A `save_link` tool call on `/mcp` with a bearer token. */
export async function saveLinkWith(world: World, token: string, url: string) {
  const res = await world.app.fetch(
    new Request(`${TEST_BASE_URL}/mcp`, {
      method: "POST",
      headers: {
        host: "links.example",
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: ++rpcId,
        method: "tools/call",
        params: { name: "save_link", arguments: { url } },
      }),
    }),
  );
  await res.text();
  return res;
}

export const SECOND_USER = { id: "owner-b", email: "b@example.com" };

export async function addSecondUser(world: World) {
  const ctx = await world.auth.$context;
  const now = new Date();
  await ctx.adapter.create({
    model: "user",
    data: {
      id: SECOND_USER.id,
      name: "B",
      email: SECOND_USER.email,
      emailVerified: false,
      createdAt: now,
      updatedAt: now,
    },
    forceAllowId: true,
  });
  await ctx.adapter.create({
    model: "account",
    data: {
      userId: SECOND_USER.id,
      providerId: "credential",
      accountId: SECOND_USER.id,
      password: await ctx.password.hash(TEST_PASSWORD),
      createdAt: now,
      updatedAt: now,
    },
  });
  new SqliteStore(world.links).ensureUser(SECOND_USER.id, "B");
  const browser = world.agent();
  const signedIn = await browser.send("/api/auth/sign-in/email", {
    method: "POST",
    json: { email: SECOND_USER.email, password: TEST_PASSWORD },
  });
  if (signedIn.status !== 200) throw new Error(`second user sign-in gave ${signedIn.status}`);
  return browser;
}

/** Consent and code exchange for a browser that is already signed in, on a client the world can resolve. */
export async function connectAs(
  world: World,
  browser: Agent,
  clientId: string,
  redirectUri: string,
) {
  const p = pkce();
  const az = await browser.send(authorizePath(clientId, redirectUri, p.challenge));
  const consent = new URL(az.headers.get("location") ?? "", TEST_BASE_URL);
  if (consent.pathname !== "/consent") throw new Error(`authorize went to ${consent.pathname}`);
  const accepted = await browser.send("/api/auth/oauth2/consent", {
    method: "POST",
    json: { accept: true, oauth_query: consent.search.slice(1) },
  });
  const code = new URL(field(accepted, "url")).searchParams.get("code") ?? "";
  const tokens = await exchange(world, code, p.verifier, {
    client_id: clientId,
    redirect_uri: redirectUri,
  });
  return { access: field(tokens, "access_token"), refresh: field(tokens, "refresh_token") };
}

export async function connectClaudeAs(world: World, browser: Agent) {
  return (await connectAs(world, browser, CLAUDE_ID, CLAUDE_REDIRECT)).access;
}

/** Connects Claude end to end and returns its tokens. */
export async function connectClaude(world: World) {
  world.net.json(CLAUDE_ID, claudeDocument);
  const p = pkce();
  const { code } = await approve(world, CLAUDE_ID, CLAUDE_REDIRECT, { challenge: p.challenge });
  const tokens = await exchange(world, code, p.verifier, {
    client_id: CLAUDE_ID,
    redirect_uri: CLAUDE_REDIRECT,
  });
  if (tokens.status !== 200) throw new Error(`token gave ${tokens.status}`);
  return { access: field(tokens, "access_token"), refresh: field(tokens, "refresh_token") };
}

/** Every row of every table in the links database, so a request can be shown to have changed nothing. */
export const allRows = (world: World) => {
  const tables = world.links
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all() as { name: string }[];
  return Object.fromEntries(
    tables.map(({ name }) => [name, world.links.prepare(`SELECT * FROM "${name}"`).all()]),
  );
};
