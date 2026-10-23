import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAgentKey } from "./auth/agent-keys.js";
import { authOptions, createAuth, migrateAuth, openAuthDatabase } from "./auth/better-auth.js";
import type { JsonFetch } from "./auth/metadata-stash.js";
import { connectClaude, oauthWorld } from "./auth/oauth-test-kit.js";
import { setOwnerLogin } from "./auth/owner-login.js";
import type { ServerConfig } from "./config.js";
import { exportManifest } from "./core/export-format.js";
import type { ExtractOutcome, PageExtractor } from "./core/extract.js";
import type {
  FetchOutcome,
  ImageFetcher,
  ImageOutcome,
  LinkChecker,
  LinkCheckOutcome,
  PageFetcher,
} from "./core/fetch.js";
import { png } from "./core/image-test-kit.js";
import { saveLink } from "./core/links.js";
import { copyLimits, imageRef } from "./core/saved-copy.js";
import { at, record } from "./core/snapshot-store-contract.js";
import { type AppDeps, createDeps } from "./deps.js";
import { FakeEmbedder } from "./search/embedder.js";
import { DIMS } from "./search/model.js";
import { type StartOptions, startServer } from "./start-server.js";

const BASE = "https://links.example";
const SECRET = "test-secret-0123456789abcdef0123456789";

import { openDatabase } from "./store/database.js";
import { SqliteKeyStore } from "./store/key-store.js";
import { SqliteSavedCopyStore } from "./store/saved-copies.js";

const URL_A = "https://example.com/served";
const SAVE = {
  jsonrpc: "2.0",
  id: 1,
  method: "tools/call",
  params: { name: "save_link", arguments: { url: URL_A } },
};

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const PAGE: ExtractOutcome = {
  kind: "ok",
  metadata: { title: "Page title", description: null, imageUrl: null, iconUrls: [] },
  text: "page text",
};

const IMAGE_URL = "https://example.com/preview.png";
/** A page whose metadata names a preview image. */
const PAGE_WITH_IMAGE: ExtractOutcome = {
  ...PAGE,
  metadata: { title: "Page title", description: null, imageUrl: IMAGE_URL, iconUrls: [] },
};
const PNG: ImageOutcome = {
  kind: "ok",
  contentType: "image/png",
  bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1]),
};

const okPage = (url: string): FetchOutcome => ({
  kind: "ok",
  finalUrl: url,
  contentType: "text/html",
  html: "<title>Page title</title><p>page text</p>",
});

/** A fetch that answers only when its signal fires. */
const hangUntilAborted = (_url: string, signal?: AbortSignal) =>
  new Promise<FetchOutcome>((resolve) => {
    signal?.addEventListener("abort", () => resolve({ kind: "aborted" }), { once: true });
  });

/**
 * A fetcher and an extractor that reach nothing outside the test; by default every page
 * succeeds. Like the real fetcher, `close()` ends a fetch in flight as a network_error, so
 * closing it before the runner has stopped would use up the attempt instead of giving it back.
 */
function fakePipeline(
  o: {
    fetch?: (url: string, signal?: AbortSignal) => Promise<FetchOutcome>;
    extract?: () => Promise<ExtractOutcome>;
    fetchImage?: (url: string, signal?: AbortSignal) => Promise<ImageOutcome>;
  } = {},
) {
  const log: string[] = [];
  const closed = { fetcher: 0, extractor: 0 };
  const fetched: string[] = [];
  const inFlight = new Set<(outcome: FetchOutcome) => void>();
  const fetcher: PageFetcher = {
    fetch: (url, signal) => {
      fetched.push(url);
      signal?.addEventListener("abort", () => log.push("abort"), { once: true });
      const own = o.fetch ? o.fetch(url, signal) : Promise.resolve(okPage(url));
      return new Promise<FetchOutcome>((resolve, reject) => {
        inFlight.add(resolve);
        own.then(resolve, reject);
      });
    },
    close: async () => {
      closed.fetcher++;
      log.push("fetcher.close");
      for (const end of inFlight) end({ kind: "network_error", code: "closed" });
    },
  };
  const extractor: PageExtractor = {
    extract: () => (o.extract ? o.extract() : Promise.resolve(PAGE)),
    close: async () => {
      closed.extractor++;
      log.push("extractor.close");
    },
  };
  const imageFetcher: ImageFetcher = {
    fetch: (url, signal) => (o.fetchImage ? o.fetchImage(url, signal) : Promise.resolve(PNG)),
    close: async () => {},
  };
  const linkChecker: LinkChecker = {
    canResolve: async () => true,
    check: async (url): Promise<LinkCheckOutcome> => ({ kind: "ok", finalUrl: url }),
    close: async () => {},
  };
  // The icon backfill's own extractor: a fake, so no test forks a real child for it.
  const iconExtractor: PageExtractor = {
    extract: () => Promise.resolve(PAGE),
    close: async () => {},
  };
  return {
    fetcher,
    extractor,
    iconExtractor,
    imageFetcher,
    linkChecker,
    embedder: new FakeEmbedder(DIMS),
    log,
    closed,
    fetched,
  };
}

/** Collects unhandled rejections and uncaught exceptions while a test runs. */
function processFaults() {
  const faults: unknown[] = [];
  const record = (e: unknown) => faults.push(e);
  process.on("unhandledRejection", record);
  process.on("uncaughtException", record);
  return {
    faults,
    dispose: () => {
      process.off("unhandledRejection", record);
      process.off("uncaughtException", record);
    },
  };
}

/** Holds every `insertIfAbsent` until `release` opens; `entered` opens when the first arrives. */
function holdInserts(release: Promise<unknown>) {
  const entered = gate();
  const results: Promise<unknown>[] = [];
  const decorateDeps = (deps: AppDeps) => {
    const store = Object.create(deps.store);
    store.insertIfAbsent = (...args: Parameters<AppDeps["store"]["insertIfAbsent"]>) => {
      const result = (async () => {
        entered.open();
        await release;
        return deps.store.insertIfAbsent(...args);
      })();
      results.push(result);
      return result;
    };
    return { ...deps, store };
  };
  return { decorateDeps, entered: entered.opened, results };
}

type Snapshot = {
  url: string;
  status: string;
  attempts: number;
  nextFetchAt: number | null;
  title: string | null;
  text: string | null;
};

describe("startServer", () => {
  let dir: string;
  let dbPath: string;
  let key: string;
  const started: Array<{ stop: () => Promise<void> }> = [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "aye-server-"));
    dbPath = join(dir, "links.db");
    const db = openDatabase(dbPath);
    key = createAgentKey(new SqliteKeyStore(db), {
      owner: "owner",
      ownerName: "Owner",
      agent: "codex",
    }).key;
    db.close();
  });

  afterEach(async () => {
    for (const s of started.splice(0)) await s.stop();
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  const post = (port: number, body: unknown, authorization = `Bearer ${key}`) =>
    fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization,
      },
      body: JSON.stringify(body),
    });

  const json = async (res: Response) => {
    const text = await res.text();
    const data = text.split("\n").find((l) => l.startsWith("data:"));
    return JSON.parse(data ? data.slice(5) : text);
  };

  const read = <T>(sql: string): T[] => {
    const db = new Database(dbPath, { readonly: true });
    try {
      return db.prepare(sql).all() as T[];
    } finally {
      db.close();
    }
  };

  const rows = () => read("SELECT url, saved_by AS savedBy FROM links");

  const authPath = () => join(dir, "auth.db");
  const cfg = (links: string, port: number): ServerConfig => ({
    dbPath: links,
    port,
    auth: { dbPath: authPath(), secret: SECRET, baseUrl: BASE },
    savedCopies: { dir: join(dir, "copies"), limitBytes: 1024 ** 3 },
    version: "v2099.01.02.3",
  });

  /** Read through a second connection, which fails while the server holds the auth file. */
  const authRows = (sql: string) => {
    const db = new Database(authPath(), { timeout: 0 });
    try {
      return db.prepare(sql).all();
    } finally {
      db.close();
    }
  };
  const authTables = () =>
    (
      authRows("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name") as {
        name: string;
      }[]
    ).map((t) => t.name);

  const snapshots = () =>
    read<Snapshot>(
      `SELECT l.url, s.fetch_status AS status, s.attempts, s.next_fetch_at AS nextFetchAt,
         s.title, s.text
       FROM snapshots s JOIN links l ON l.id = s.link_id ORDER BY l.id`,
    );

  /** Polls until `pass`; on a timeout the error shows the snapshots as they were. */
  const until = async (pass: () => boolean, what: string) => {
    for (let i = 0; i < 150; i++) {
      if (pass()) return;
      await sleep(20);
    }
    throw new Error(`${what} never happened; snapshots: ${JSON.stringify(snapshots())}`);
  };

  /** A link saved before the server starts, as the backlog is: its snapshot is pending and due. */
  const seed = async (url: string) => {
    const db = openDatabase(dbPath);
    try {
      await saveLink(createDeps(db, new FakeEmbedder(DIMS)), "owner", { url, savedBy: "seed" });
    } finally {
      db.close();
    }
  };

  /** Starts with a fake pipeline unless the test passes one, so no test reaches the network. */
  const logged: string[] = [];
  const start = async (options: StartOptions = {}, port = 0) => {
    const s = await startServer(cfg(dbPath, port), {
      ...fakePipeline(),
      settleMs: 200,
      requestLog: (line) => logged.push(line),
      ...options,
    });
    started.push(s);
    return s;
  };

  it("saves through a real key over HTTP into the file database", async () => {
    const { port } = await start();
    const res = await post(port, SAVE);
    expect(res.status).toBe(200);
    expect(rows()).toEqual([{ url: URL_A, savedBy: "codex" }]);
  });

  it("reports the configured version to MCP clients", async () => {
    const { port } = await start();
    const res = await post(port, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "0" },
      },
    });
    expect((await json(res)).result.serverInfo.version).toBe("v2099.01.02.3");
  });

  it("refuses a request without a valid key and writes nothing", async () => {
    const { port } = await start();
    const res = await post(port, SAVE, "Bearer aak_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    expect(res.status).toBe(401);
    expect(rows()).toEqual([]);
    expect(logged).toContainEqual(
      expect.stringMatching(/^\[http\] \d{4}-\d\d-\d\dT\S+Z POST \/mcp 401 /),
    );
  });

  it("lets an in-flight request finish and commit before closing the database", async () => {
    const release = gate();
    const held = holdInserts(release.opened);
    const { port, stop } = await start({ decorateDeps: held.decorateDeps });

    const inFlight = post(port, SAVE);
    await held.entered;
    let stopped = false;
    const stopping = stop().then(() => {
      stopped = true;
    });
    await sleep(150);
    expect(stopped).toBe(false);

    release.open();
    const res = await inFlight;
    await stopping;
    expect(res.status).toBe(200);
    expect(rows()).toEqual([{ url: URL_A, savedBy: "codex" }]);
  });

  it("refuses new connections once stopping", async () => {
    const release = gate();
    const held = holdInserts(release.opened);
    const { port, stop } = await start({ decorateDeps: held.decorateDeps });
    const inFlight = post(port, SAVE);
    await held.entered;
    const stopping = stop();
    await sleep(50);
    await expect(post(port, SAVE)).rejects.toThrow();
    release.open();
    await inFlight;
    await stopping;
    expect(rows()).toHaveLength(1);
  });

  it("closes a keep-alive connection as soon as its last response is sent", async () => {
    const release = gate();
    const held = holdInserts(release.opened);
    const { port, stop } = await start({ decorateDeps: held.decorateDeps });
    const agent = new http.Agent({ keepAlive: true, keepAliveMsecs: 60_000 });
    const status = new Promise<number>((resolve, reject) => {
      const req = http.request(
        {
          port,
          host: "127.0.0.1",
          method: "POST",
          path: "/mcp",
          agent,
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            authorization: `Bearer ${key}`,
          },
        },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode ?? 0));
        },
      );
      req.on("error", reject);
      req.end(JSON.stringify(SAVE));
    });
    await held.entered;
    const stopping = stop();
    release.open();
    expect(await status).toBe(200);
    const sent = Date.now();
    await stopping;
    agent.destroy();
    expect(Date.now() - sent).toBeLessThan(1000);
  });

  it("gives up on a request that outlasts the drain and the settle bound, and still stops", async () => {
    const held = holdInserts(new Promise<never>(() => {}));
    const { port, stop } = await start({ decorateDeps: held.decorateDeps, drainMs: 100 });
    const inFlight = post(port, SAVE)
      .then((r) => r.text())
      .catch((e: unknown) => e);
    await held.entered;
    await stop();
    expect(await inFlight).toBeInstanceOf(Error);
    expect(rows()).toEqual([]);
  });

  it("waits, after the drain, for a tool call still running, and commits it before closing", async () => {
    const release = gate();
    const held = holdInserts(release.opened);
    const { port, stop } = await start({
      decorateDeps: held.decorateDeps,
      drainMs: 100,
      settleMs: 5_000,
    });
    const inFlight = post(port, SAVE)
      .then((r) => r.text())
      .catch((e: unknown) => e);
    await held.entered;
    let stopped = false;
    const stopping = stop().then(() => {
      stopped = true;
    });
    // Past the drain: the connection has been closed under the call.
    await sleep(400);
    expect(await inFlight).toBeInstanceOf(Error);
    expect(stopped).toBe(false);
    release.open();
    await stopping;
    expect(rows()).toEqual([{ url: URL_A, savedBy: "codex" }]);
  });

  it("logs, and does not crash, when a tool call resumes after the settle bound", async () => {
    const faults = processFaults();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const release = gate();
      const held = holdInserts(release.opened);
      const { port, stop } = await start({
        decorateDeps: held.decorateDeps,
        drainMs: 100,
        settleMs: 100,
      });
      void post(port, SAVE).catch(() => {});
      await held.entered;
      await stop();
      expect(errors.mock.calls.flat().join(" ")).toContain("1 MCP call");
      release.open();
      await expect(held.results[0]).rejects.toThrow(/database connection is not open/);
      await sleep(200);
      expect(errors.mock.calls.flat().map(String).join(" ")).toContain(
        "database connection is not open",
      );
      expect(faults.faults).toEqual([]);
      expect(rows()).toEqual([]);
    } finally {
      faults.dispose();
    }
  });

  it("closes the database handle on stop, and stop can be called twice", async () => {
    const { stop } = await start();
    expect(existsSync(`${dbPath}-wal`)).toBe(true);
    await stop();
    expect(existsSync(`${dbPath}-wal`)).toBe(false);
    await expect(stop()).resolves.toBeUndefined();
  });

  it("deletes a stale export and its temporary file beside the database at start, and keeps other names", async () => {
    const folder = join(dir, "exports");
    mkdirSync(folder);
    const names = [`${"a".repeat(32)}.zip`, `${"b".repeat(32)}.zip.tmp-${"c".repeat(16)}`];
    for (const name of [...names, "notes.txt"]) writeFileSync(join(folder, name), "x");
    await start();
    expect(readdirSync(folder)).toEqual(["notes.txt"]);
  });

  it("on stop, tells export builds to stop before anything closes", async () => {
    const events: string[] = [];
    const close = Database.prototype.close;
    vi.spyOn(Database.prototype, "close").mockImplementation(function (this: Database.Database) {
      events.push("db.close");
      return close.call(this);
    });
    const { stop } = await start({
      decorateDeps: (deps) => {
        const stopBuilds = deps.exports.stop;
        deps.exports.stop = () => {
          events.push("exports.stop");
          stopBuilds();
        };
        return deps;
      },
      jsonFetcher: {
        fetch: () => Promise.reject(new Error("no metadata fetch in this test")),
        close: async () => void events.push("jsonFetcher.close"),
      },
    });
    await stop();
    expect(events).toEqual(["exports.stop", "jsonFetcher.close", "db.close", "db.close"]);
  });

  describe("startup failures", () => {
    const freePort = () =>
      new Promise<number>((resolve) => {
        const s = net.createServer().listen(0, "127.0.0.1", () => {
          const { port } = s.address() as net.AddressInfo;
          s.close(() => resolve(port));
        });
      });
    const listening = (port: number) =>
      new Promise<boolean>((resolve) => {
        const c = net.connect(port, "127.0.0.1");
        c.once("connect", () => {
          c.destroy();
          resolve(true);
        });
        c.once("error", () => resolve(false));
      });

    it("fails before opening the database when the model cannot load, and listens on nothing", async () => {
      vi.stubEnv("HOME", dir);
      const fresh = join(dir, "fresh.db");
      const port = await freePort();
      const { fetcher, extractor } = fakePipeline();
      await expect(startServer(cfg(fresh, port), { fetcher, extractor })).rejects.toThrow();
      expect(existsSync(fresh)).toBe(false);
      expect(await listening(port)).toBe(false);
      vi.unstubAllEnvs();
    });

    it("closes the database and the pipeline when startup fails after the database opens", async () => {
      const fresh = join(dir, "fresh.db");
      const pipeline = fakePipeline();
      const boom = new Error("deps failed");
      await expect(
        startServer(cfg(fresh, 0), {
          ...pipeline,
          decorateDeps: () => {
            throw boom;
          },
        }),
      ).rejects.toBe(boom);
      expect(existsSync(fresh)).toBe(true);
      expect(existsSync(`${fresh}-wal`)).toBe(false);
      expect(pipeline.closed).toEqual({ fetcher: 1, extractor: 1 });
    });

    it("does not listen until the auth migrations have finished", async () => {
      const port = await freePort();
      const entered = gate();
      const release = gate();
      const starting = start(
        {
          wrapAuthMigrations: async (migrate) => {
            entered.open();
            await release.opened;
            await migrate();
          },
        },
        port,
      );
      await entered.opened;
      await sleep(50);
      expect(await listening(port)).toBe(false);
      release.open();
      await starting;
      expect(await listening(port)).toBe(true);
    });

    it("fails the start when the auth schema has problems, with both databases and the pipeline closed", async () => {
      const port = await freePort();
      const before = new Database(authPath());
      before.exec(`CREATE TABLE "user" (id text primary key, surprise text not null)`);
      before.close();
      const pipeline = fakePipeline();
      await expect(startServer(cfg(dbPath, port), pipeline)).rejects.toThrow(
        /auth database schema has problems.*surprise/,
      );
      expect(await listening(port)).toBe(false);
      expect(pipeline.closed).toEqual({ fetcher: 1, extractor: 1 });
      expect(existsSync(`${dbPath}-wal`)).toBe(false);
      expect(authTables()).toEqual(["user"]);
    });
  });

  describe("auth", () => {
    it("holds the auth database while running, and releases it, migrated, on stop", async () => {
      const { stop } = await start();
      expect(() => authTables()).toThrow(expect.objectContaining({ code: "SQLITE_BUSY" }));
      await stop();
      expect(authTables()).toEqual(expect.arrayContaining(["oauthClient", "session", "user"]));
    });

    /** Gives the owner a web login before the server starts. */
    const ownerLogin = async () => {
      const auth = openAuthDatabase(authPath());
      const options = authOptions({ db: auth, secret: SECRET, baseUrl: BASE });
      await migrateAuth(options);
      await setOwnerLogin(createAuth(options).auth, {
        id: "owner",
        name: "Owner",
        email: "you@example.com",
        password: "Correct-horse-battery-1",
      });
      auth.close();
    };
    const signIn = (port: number) =>
      fetch(`http://127.0.0.1:${port}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: BASE },
        body: JSON.stringify({ email: "you@example.com", password: "Correct-horse-battery-1" }),
      });

    it("signs the owner in over loopback HTTP, as Tailscale Serve forwards it, and serves the owner's links on /search with the session", async () => {
      await seed("https://example.com/served-home");
      await ownerLogin();

      const { port, stop } = await start();
      const signedIn = await signIn(port);
      expect(signedIn.status).toBe(200);
      const [cookie] = signedIn.headers.getSetCookie();
      expect(cookie).toMatch(/; Secure/);
      const home = await fetch(`http://127.0.0.1:${port}/search`, {
        headers: { cookie: (cookie ?? "").split(";")[0] ?? "" },
        redirect: "manual",
      });
      expect(home.status).toBe(200);
      expect(await home.text()).toContain("https://example.com/served-home");
      await stop();
      expect(authRows("SELECT userId FROM session")).toEqual([{ userId: "owner" }]);
    });

    it("stopping the server aborts a turn waiting on the model, before the drain", async () => {
      await ownerLogin();
      // An OpenAI-style AI that takes every request and never answers it.
      let asked!: () => void;
      const waiting = new Promise<void>((resolve) => {
        asked = resolve;
      });
      const ai = http.createServer(() => asked());
      await new Promise<void>((resolve) => ai.listen(0, "127.0.0.1", resolve));
      const aiPort = (ai.address() as net.AddressInfo).port;
      try {
        const s = await startServer(
          {
            ...cfg(dbPath, 0),
            ai: {
              api: "openai",
              url: `http://127.0.0.1:${aiPort}/v1`,
              key: undefined,
              model: "m",
              name: "Fake",
            },
          },
          { ...fakePipeline(), drainMs: 5_000, settleMs: 200, requestLog: () => {} },
        );
        started.push(s);
        const cookie = ((await signIn(s.port)).headers.getSetCookie()[0] ?? "").split(";")[0] ?? "";
        const answer = fetch(`http://127.0.0.1:${s.port}/ai/chat`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: BASE, cookie },
          body: JSON.stringify({ history: [], text: "Save example.com" }),
        });
        await waiting;
        const stopAt = Date.now();
        await s.stop();
        expect(Date.now() - stopAt).toBeLessThan(2_000);
        const res = await answer;
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({
          ok: false,
          ai: "Fake",
          message: "Fake didn't answer: the server is stopping.",
          remember: "Fake didn't answer: the server is stopping.",
          cards: {},
          changes: [],
        });
        expect(rows()).toEqual([]);
      } finally {
        ai.closeAllConnections();
        await new Promise((resolve) => ai.close(resolve));
      }
      // Past the drain limit, so a stop that waits out the drain fails on the timing, not the timeout.
    }, 15_000);

    const claudeBeforeStart = async () => {
      const authDb = openAuthDatabase(authPath());
      const world = await oauthWorld({ authDb });
      const claude = await connectClaude(world);
      await world.refresher.stop();
      authDb.close();
      return { net: world.net, claude };
    };

    const fetchesReach = async (net: { calls: unknown[] }, n: number) => {
      for (let i = 0; i < 200 && net.calls.length < n; i++) await sleep(10);
      expect(net.calls.length).toBeGreaterThanOrEqual(n);
    };

    it("keeps refreshing connected clients while it runs, so a token still works well past F", async () => {
      const { net, claude } = await claudeBeforeStart();
      vi.useFakeTimers({ toFake: ["Date"], now: Date.now() });
      try {
        const { port } = await start({
          jsonFetcher: { fetch: net.fetch, close: async () => {} },
          refresherIntervalMs: 20,
        });
        for (let step = 0; step < 4; step++) {
          vi.setSystemTime(Date.now() + 2 * 60_000);
          await fetchesReach(net, net.calls.length + 1);
        }
        const res = await post(port, SAVE, `Bearer ${claude.access}`);
        expect(res.status).toBe(200);
      } finally {
        vi.useRealTimers();
      }
    });

    it("on stop, aborts a metadata fetch in flight and waits for it before closing the JSON fetcher, then fetches nothing more", async () => {
      const { net } = await claudeBeforeStart();
      const events: string[] = [];
      let hang = false;
      const fetch: JsonFetch = (url, init) => {
        if (!hang) return net.fetch(url, init);
        events.push("fetching");
        return new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () =>
            setTimeout(() => {
              events.push("aborted");
              reject(new Error("aborted"));
            }, 20),
          );
        });
      };
      const { stop } = await start({
        jsonFetcher: { fetch, close: async () => void events.push("fetcher closed") },
        refresherIntervalMs: 20,
      });
      hang = true;
      for (let i = 0; i < 200 && !events.includes("fetching"); i++) await sleep(10);
      await stop();
      expect(events).toEqual(["fetching", "aborted", "fetcher closed"]);
      await sleep(100);
      expect(events).toEqual(["fetching", "aborted", "fetcher closed"]);
    });

    it("fills the metadata stash before it listens, so a connected client's token works on the first request", async () => {
      const { net, claude } = await claudeBeforeStart();
      const before = net.calls.length;

      const { port } = await start({ jsonFetcher: { fetch: net.fetch, close: async () => {} } });
      expect(net.calls.length).toBe(before + 1);
      const res = await post(port, SAVE, `Bearer ${claude.access}`);
      expect(res.status).toBe(200);
      expect(rows()).toEqual([{ url: URL_A, savedBy: "Claude" }]);
    });
  });

  describe("page snapshots", () => {
    it("fetches a new link's page in the background and records it ok", async () => {
      const { port } = await start();
      expect((await post(port, SAVE)).status).toBe(200);
      await until(() => snapshots()[0]?.status === "ok", "an ok snapshot");
      expect(snapshots()).toMatchObject([
        { url: URL_A, status: "ok", attempts: 1, title: "Page title", text: "page text" },
      ]);
    });

    it("answers save_link with the fetched page and its excerpt, without polling (D12)", async () => {
      const { port } = await start();
      const res = await json(await post(port, SAVE));
      expect(res.result.structuredContent.link.snapshot).toMatchObject({
        status: "ok",
        title: "Page title",
      });
      expect(res.result.structuredContent.snapshotText).toEqual({
        text: "page text",
        truncated: false,
      });
    });

    it("leases and fetches nothing for a repeat save", async () => {
      const pipeline = fakePipeline();
      const leases: string[] = [];
      const { port } = await start({
        ...pipeline,
        decorateDeps: (deps) => {
          const store = Object.create(deps.store);
          store.leaseSnapshot = (...args: Parameters<AppDeps["store"]["leaseSnapshot"]>) => {
            leases.push(args[1]);
            return deps.store.leaseSnapshot(...args);
          };
          return { ...deps, store };
        },
      });
      await post(port, SAVE);
      await until(() => snapshots()[0]?.status === "ok", "an ok snapshot");
      const repeat = await json(await post(port, SAVE));
      expect(repeat.result.structuredContent.created).toBe(false);
      await sleep(100);
      expect(leases).toHaveLength(1);
      expect(pipeline.fetched).toEqual([URL_A]);
    });

    it("starts no snapshot job once stopping, even for a save that commits during the drain", async () => {
      const release = gate();
      const held = holdInserts(release.opened);
      const pipeline = fakePipeline();
      const leases: string[] = [];
      const { port, stop } = await start({
        ...pipeline,
        drainMs: 5_000,
        decorateDeps: (deps) => {
          const decorated = held.decorateDeps(deps);
          const store = Object.create(decorated.store);
          store.leaseSnapshot = (...args: Parameters<AppDeps["store"]["leaseSnapshot"]>) => {
            leases.push(args[1]);
            return deps.store.leaseSnapshot(...args);
          };
          return { ...decorated, store };
        },
      });
      const inFlight = post(port, SAVE);
      await held.entered;
      const stopping = stop();
      release.open();
      expect((await inFlight).status).toBe(200);
      await stopping;
      expect(rows()).toEqual([{ url: URL_A, savedBy: "codex" }]);
      expect(leases).toEqual([]);
      expect(pipeline.fetched).toEqual([]);
      expect(snapshots()).toMatchObject([{ status: "pending", attempts: 0 }]);
    });

    it("picks up the backlog when it starts", async () => {
      await seed("https://example.com/backlog");
      await start();
      await until(() => snapshots()[0]?.status === "ok", "the backlog's ok snapshot");
      expect(snapshots()).toMatchObject([{ url: "https://example.com/backlog", status: "ok" }]);
    });

    it("on stop, aborts running jobs before closing the pipeline and gives their attempts back", async () => {
      await seed("https://example.com/backlog");
      const pipeline = fakePipeline({ fetch: hangUntilAborted });
      const released: boolean[] = [];
      const { port, stop } = await start({
        ...pipeline,
        // The save's page never arrives, so the save waits this long instead of 4 s.
        saveWaitMs: 50,
        decorateDeps: (deps) => {
          const store = Object.create(deps.store);
          store.releaseSnapshot = async (
            ...args: Parameters<AppDeps["store"]["releaseSnapshot"]>
          ) => {
            const ok = await deps.store.releaseSnapshot(...args);
            pipeline.log.push("release");
            released.push(ok);
            return ok;
          };
          return { ...deps, store };
        },
      });
      // The startup sweep holds the backlog's page; this save's page takes the second slot.
      await until(() => pipeline.fetched.length === 1, "the backlog fetch");
      expect((await post(port, SAVE)).status).toBe(200);
      await until(() => pipeline.fetched.length === 2, "the saved link's fetch");
      expect(snapshots().map((s) => s.attempts)).toEqual([1, 1]);

      const before = Date.now();
      await stop();
      await stop();

      expect(released).toEqual([true, true]);
      for (const s of snapshots()) {
        expect(s).toMatchObject({ status: "pending", attempts: 0 });
        expect(s.nextFetchAt).not.toBeNull();
        expect(s.nextFetchAt as number).toBeLessThanOrEqual(Date.now());
        expect(s.nextFetchAt as number).toBeGreaterThanOrEqual(before - 1000);
      }
      expect(pipeline.closed).toEqual({ fetcher: 1, extractor: 1 });
      expect(pipeline.log).toEqual([
        "abort",
        "abort",
        "release",
        "release",
        "fetcher.close",
        "extractor.close",
      ]);
    });

    it("closes the pipeline and leases nothing when it cannot listen", async () => {
      await seed("https://example.com/backlog");
      const taken = net.createServer();
      await new Promise<void>((r) => taken.listen(0, "127.0.0.1", r));
      const port = (taken.address() as net.AddressInfo).port;
      const pipeline = fakePipeline();
      try {
        await expect(startServer(cfg(dbPath, port), pipeline)).rejects.toThrow(/EADDRINUSE/);
      } finally {
        await new Promise((r) => taken.close(r));
      }
      await sleep(50);
      expect(pipeline.closed).toEqual({ fetcher: 1, extractor: 1 });
      expect(pipeline.fetched).toEqual([]);
      expect(snapshots()).toMatchObject([{ status: "pending", attempts: 0 }]);
      expect(read("SELECT lease_token AS token FROM snapshots")).toEqual([{ token: 0 }]);
    });

    it("shows save_link as open-world in tools/list", async () => {
      const { port } = await start();
      const list = await json(await post(port, { jsonrpc: "2.0", id: 2, method: "tools/list" }));
      const save = list.result.tools.find((t: { name: string }) => t.name === "save_link");
      expect(save.annotations.openWorldHint).toBe(true);
    });

    it.each([
      [
        "fetcher",
        {
          fetch: async () => {
            throw new Error("fetcher exploded");
          },
        },
      ],
      [
        "extractor",
        {
          extract: async () => {
            throw new Error("extractor exploded");
          },
        },
      ],
    ])("still answers a committed save when the %s throws", async (_which, faulty) => {
      const faults = processFaults();
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const pipeline = fakePipeline(faulty);
        const { port } = await start(pipeline);
        const res = await json(await post(port, SAVE));
        expect(res.result.isError).toBeUndefined();
        expect(res.result.structuredContent).toMatchObject({ created: true });
        await until(
          () => errors.mock.calls.flat().map(String).join(" ").includes("exploded"),
          "the logged job failure",
        );
        expect(rows()).toEqual([{ url: URL_A, savedBy: "codex" }]);
        expect(faults.faults).toEqual([]);
      } finally {
        faults.dispose();
      }
    });
  });

  describe("saved copies", () => {
    const copiesDir = () => join(dir, "copies");
    const DRAFT = { markdown: "# Saved\n\nbody", imageUrls: [], nonce: "a".repeat(32) };
    const WITH_COPY: ExtractOutcome = { ...PAGE, copy: DRAFT };
    const copyRows = () =>
      read<{ linkId: number; status: string }>(
        "SELECT link_id AS linkId, status FROM saved_copies ORDER BY link_id",
      );
    const linkIds = () => read<{ id: number }>("SELECT id FROM links").map((r) => r.id);
    const startWith = async (savedCopies: ServerConfig["savedCopies"], options: StartOptions) => {
      const s = await startServer(
        { ...cfg(dbPath, 0), savedCopies },
        { ...fakePipeline(), settleMs: 200, requestLog: (l) => logged.push(l), ...options },
      );
      started.push(s);
      return s;
    };
    const ON = () => ({ dir: copiesDir(), limitBytes: 1024 ** 3 });

    it("keeps a copy of a newly saved page beside its snapshot", async () => {
      await seed("https://example.com/a");
      await startWith(ON(), {
        extractor: fakePipeline({ extract: async () => WITH_COPY }).extractor,
      });
      await until(() => copyRows().length === 1, "a saved copy row");
      const [id] = linkIds();
      expect(copyRows()).toEqual([{ linkId: id, status: "ok" }]);
      expect(readFileSync(join(copiesDir(), String(id), "copy.md"), "utf8")).toBe(DRAFT.markdown);
    });

    it("asks for no copy at limit 0 and writes none", async () => {
      await seed("https://example.com/a");
      const asked: unknown[] = [];
      const extractor: PageExtractor = {
        extract: async (_h, _u, _s, options) => {
          asked.push(options);
          return PAGE;
        },
        close: async () => {},
      };
      await startWith({ dir: copiesDir(), limitBytes: 0 }, { extractor });
      await until(() => snapshots()[0]?.status === "ok", "the snapshot");
      expect(asked).toEqual([{ copy: false }]);
      expect(copyRows()).toEqual([]);
      expect(existsSync(join(copiesDir(), String(linkIds()[0])))).toBe(false);
    });

    it("starts and keeps snapshotting when the folder belongs to no library, leaving it alone", async () => {
      mkdirSync(copiesDir());
      writeFileSync(join(copiesDir(), "notes.txt"), "mine");
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      await seed("https://example.com/a");
      await startWith(ON(), {
        extractor: fakePipeline({ extract: async () => WITH_COPY }).extractor,
      });
      await until(() => snapshots()[0]?.status === "ok", "the snapshot");
      expect(copyRows()).toEqual([]);
      expect(readdirSync(copiesDir())).toEqual(["notes.txt"]);
      expect(readFileSync(join(copiesDir(), "notes.txt"), "utf8")).toBe("mine");
      const logs = errors.mock.calls.flat().join("\n");
      expect(logs).toContain(`[saved copies] paused (${copiesDir()})`);
      expect(logs).toContain("move this one aside and restart");
    });

    it.skipIf(process.getuid?.() === 0)(
      "advises granting access, not moving the folder aside, when its own folder can't be read",
      async () => {
        const db = openDatabase(dbPath);
        try {
          expect(await new SqliteSavedCopyStore(db, copiesDir()).checkFolder()).toEqual({
            state: "ready",
          });
        } finally {
          db.close();
        }
        chmodSync(copiesDir(), 0o000);
        const errors = vi.spyOn(console, "error").mockImplementation(() => {});
        try {
          await startWith(ON(), {});
        } finally {
          chmodSync(copiesDir(), 0o755);
        }
        const logs = errors.mock.calls.flat().join("\n");
        expect(logs).toContain("[saved copies] paused");
        expect(logs).toContain("Privacy & Security");
        expect(logs).not.toContain("move this one aside");
      },
    );

    it("refuses the start when start-up recovery hits a database error, and closes what it opened", async () => {
      const s = await startWith(ON(), {});
      await s.stop();
      started.pop();
      const db = openDatabase(dbPath);
      let ddl: string;
      try {
        ddl = db
          .prepare("SELECT sql FROM sqlite_master WHERE name = 'saved_copy_images'")
          .pluck()
          .get() as string;
        db.exec("DROP TABLE saved_copy_images");
      } finally {
        db.close();
      }
      vi.spyOn(console, "error").mockImplementation(() => {});
      const pipeline = fakePipeline();
      await expect(startWith(ON(), pipeline)).rejects.toThrow(/saved_copy_images/);
      expect(pipeline.closed).toEqual({ fetcher: 1, extractor: 1 });
      const back = openDatabase(dbPath);
      try {
        back.exec(ddl);
      } finally {
        back.close();
      }
      await startWith(ON(), {});
    });

    it("undoes a copy left mid-write before the start resolves", async () => {
      const db = openDatabase(dbPath);
      let id: number;
      try {
        expect(await new SqliteSavedCopyStore(db, copiesDir()).checkFolder()).toEqual({
          state: "ready",
        });
        const deps = createDeps(db, new FakeEmbedder(DIMS));
        await saveLink(deps, "owner", { url: "https://example.com/a", savedBy: "seed" });
        id = db.prepare("SELECT id FROM links").pluck().get() as number;
        db.prepare(
          "INSERT INTO saved_copies (owner_id, link_id, status, made_at) VALUES ('owner', ?, 'saving', 1)",
        ).run(id);
        mkdirSync(join(copiesDir(), String(id)));
        writeFileSync(join(copiesDir(), String(id), "copy.md"), "half");
      } finally {
        db.close();
      }
      await startWith(ON(), {});
      expect(copyRows()).toEqual([]);
      expect(existsSync(join(copiesDir(), String(id)))).toBe(false);
    });
  });

  describe("the copy pass", () => {
    const copiesDir = () => join(dir, "copies");
    const ON = () => ({ dir: copiesDir(), limitBytes: 1024 ** 3 });
    const NONCE = "b".repeat(32);
    const IMG = "https://example.com/pic.png";
    const WITH_IMAGE: ExtractOutcome = {
      ...PAGE,
      copy: { markdown: `![pic](${imageRef(1, NONCE)})`, imageUrls: [IMG], nonce: NONCE },
    };
    const copyRow = () =>
      read<{ status: string; finished: number | null; image: string | null }>(
        `SELECT c.status, c.finished_at AS finished,
           (SELECT status FROM saved_copy_images i WHERE i.link_id = c.link_id AND i.n = 1) AS image
         FROM saved_copies c`,
      );
    const startWith = async (options: StartOptions) => {
      const s = await startServer(
        { ...cfg(dbPath, 0), savedCopies: ON() },
        {
          ...fakePipeline(),
          settleMs: 200,
          requestLog: (l) => logged.push(l),
          copyPollMs: 20,
          ...options,
        },
      );
      started.push(s);
      return s;
    };

    /** A link saved before saved copies existed: its snapshot is done and it has no copy row. */
    const seedFetched = async () => {
      const db = openDatabase(dbPath);
      try {
        const deps = createDeps(db, new FakeEmbedder(DIMS));
        await saveLink(deps, "owner", { url: "https://example.com/old", savedBy: "seed" });
        const id = String(db.prepare("SELECT id FROM links").pluck().get());
        const now = deps.now();
        const lease = await deps.store.leaseSnapshot(
          "owner",
          id,
          now,
          new Date(now.getTime() + 100_000),
        );
        expect(lease).not.toBeNull();
        await deps.store.recordSnapshot(
          "owner",
          id,
          lease?.claim ?? -1,
          record({ imageUrl: null, text: "body" }),
        );
        return id;
      } finally {
        db.close();
      }
    };
    const copyExtractor = (extract: () => Promise<ExtractOutcome>): PageExtractor => ({
      extract,
      close: async () => {},
    });
    const readyFolder = async () => {
      const db = openDatabase(dbPath);
      try {
        expect(await new SqliteSavedCopyStore(db, copiesDir()).checkFolder()).toEqual({
          state: "ready",
        });
      } finally {
        db.close();
      }
    };

    it("reads a copy through the deps' own store, checked at start and by the pass", async () => {
      const id = await seedFetched();
      let recorded: AppDeps["savedCopies"] | undefined;
      const checks = vi.fn();
      await startWith({
        copyExtractor: copyExtractor(async () => WITH_IMAGE),
        copyPollMs: 60_000,
        decorateDeps: (d) => {
          recorded = d.savedCopies;
          const real = d.savedCopies.checkFolder.bind(d.savedCopies);
          vi.spyOn(d.savedCopies, "checkFolder").mockImplementation(async () => {
            checks();
            return real();
          });
          return d;
        },
      });
      await until(() => copyRow()[0]?.status === "ok", "the finished copy");
      expect(checks).toHaveBeenCalled();
      const before = checks.mock.calls.length;
      const copy = await recorded?.readCopy("owner", id);
      expect(copy).toEqual(expect.objectContaining({ markdown: expect.any(String) }));
      expect(checks.mock.calls.length).toBe(before);
    });

    it("serves the page of a copy the pass made, through the one checked store", async () => {
      const id = await seedFetched();
      const auth = openAuthDatabase(authPath());
      const options = authOptions({ db: auth, secret: SECRET, baseUrl: BASE });
      await migrateAuth(options);
      await setOwnerLogin(createAuth(options).auth, {
        id: "owner",
        name: "Owner",
        email: "you@example.com",
        password: "Correct-horse-battery-1",
      });
      auth.close();
      const { port } = await startWith({ copyExtractor: copyExtractor(async () => WITH_IMAGE) });
      await until(() => copyRow()[0]?.finished != null, "the finished copy");
      const signIn = await fetch(`http://127.0.0.1:${port}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: BASE },
        body: JSON.stringify({ email: "you@example.com", password: "Correct-horse-battery-1" }),
      });
      expect(signIn.status).toBe(200);
      const cookie = (signIn.headers.getSetCookie()[0] ?? "").split(";")[0] ?? "";
      const res = await fetch(`http://127.0.0.1:${port}/links/${id}/copy`, {
        headers: { cookie },
        redirect: "manual",
      });
      const html = await res.text();
      expect(res.status).toBe(200);
      expect(html).toContain(`src="/links/${id}/copy/images/1"`);
      expect(html).not.toContain("files are missing");
    });

    it("makes the copy of a link saved before copies existed, then its pictures", async () => {
      const id = await seedFetched();
      await startWith({ copyExtractor: copyExtractor(async () => WITH_IMAGE) });
      await until(() => copyRow()[0]?.finished != null, "the finished copy");
      expect(copyRow()).toEqual([{ status: "ok", finished: expect.any(Number), image: "ok" }]);
      expect(readFileSync(join(copiesDir(), String(id), "copy.md"), "utf8")).toContain(
        "images/01.png",
      );
    });

    it.skipIf(process.getuid?.() === 0)(
      "makes the copy once its folder can be written again, with no restart",
      async () => {
        await readyFolder();
        await seedFetched();
        vi.spyOn(console, "error").mockImplementation(() => {});
        chmodSync(copiesDir(), 0o555);
        try {
          await startWith({ copyExtractor: copyExtractor(async () => WITH_IMAGE) });
          await sleep(300);
          expect(copyRow()).toEqual([]);
        } finally {
          chmodSync(copiesDir(), 0o755);
        }
        await until(() => copyRow()[0]?.image === "ok", "the copy after the folder opened");
      },
    );

    it("deletes a removed copy's files once the Undo window has passed, even at limit 0", async () => {
      const id = await seedFetched();
      const db = openDatabase(dbPath);
      try {
        const store = new SqliteSavedCopyStore(db, copiesDir());
        expect(await store.checkFolder()).toEqual({ state: "ready" });
        const draft = { markdown: "# Kept", imageUrls: [], nonce: NONCE };
        const limits = { copyBytes: 1024 ** 2, totalBytes: 1024 ** 3 };
        expect(await store.saveCopy("owner", id, draft, limits, at(2))).toBe("saved");
      } finally {
        db.close();
      }
      let time = Date.now();
      const clock = () => new Date(time);
      let captured: AppDeps | undefined;
      let purges = 0;
      const s = await startServer(
        { ...cfg(dbPath, 0), savedCopies: { dir: copiesDir(), limitBytes: 0 } },
        {
          ...fakePipeline(),
          settleMs: 200,
          requestLog: (l) => logged.push(l),
          copyPollMs: 20,
          decorateDeps: (d) => {
            captured = d;
            const real = d.savedCopies.purgeRemoved.bind(d.savedCopies);
            vi.spyOn(d.savedCopies, "purgeRemoved").mockImplementation(async (before) => {
              const purged = await real(before);
              purges++;
              return purged;
            });
            return { ...d, now: clock };
          },
        },
      );
      started.push(s);
      const folder = join(copiesDir(), id);
      expect(await captured?.savedCopies.removeCopy("owner", id, clock())).toBe(true);
      const atRemove = purges;
      await until(() => purges > atRemove, "a purge after the removal");
      expect(existsSync(folder)).toBe(true);
      time += 61_000;
      await until(() => !existsSync(folder), "the removed copy's deletion");
      expect(
        read(`SELECT status, bytes, md_bytes AS mdBytes, image_nonce AS nonce,
                finished_at AS finished FROM saved_copies`),
      ).toEqual([{ status: "removed", bytes: 0, mdBytes: 0, nonce: null, finished: null }]);
      expect(read("SELECT COUNT(*) AS n FROM saved_copy_images")).toEqual([{ n: 0 }]);
      expect(await captured?.savedCopies.readCopy("owner", id)).toBeNull();
    });

    it("on stop, ends with the copy extractor pending and closes it", async () => {
      await seedFetched();
      let asked = false;
      const events: string[] = [];
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      const pending: PageExtractor = {
        extract: (_html, _url, signal) => {
          asked = true;
          return new Promise<ExtractOutcome>((resolve) => {
            signal?.addEventListener(
              "abort",
              () => {
                events.push("aborted");
                resolve({ kind: "aborted" });
              },
              { once: true },
            );
          });
        },
        close: async () => void events.push("closed"),
      };
      const { stop } = await startWith({ copyExtractor: pending });
      await until(() => asked, "the copy extraction");
      await stop();
      expect(events).toEqual(["aborted", "closed"]);
      expect(errors.mock.calls.flat().join("\n")).not.toContain("copy pass still running");
      expect(copyRow()).toEqual([]);
    });
  });

  describe("preview images", () => {
    const images = () =>
      read<{ status: string | null; stored: number }>(
        `SELECT s.image_status AS status, (SELECT count(*) FROM link_images) AS stored
         FROM snapshots s ORDER BY s.link_id`,
      );

    it("stores a saved page's preview image in the background", async () => {
      const { port } = await start({
        ...fakePipeline({ extract: async () => PAGE_WITH_IMAGE }),
        imagePollMs: 20,
      });
      expect((await post(port, SAVE)).status).toBe(200);
      await until(() => images()[0]?.status === "ok", "a stored image");
      expect(images()).toEqual([{ status: "ok", stored: 1 }]);
    });

    const ICON_URL = "https://example.com/icon.png";
    const PAGE_WITH_ICON: ExtractOutcome = {
      kind: "ok",
      metadata: { title: "Page title", description: null, imageUrl: null, iconUrls: [ICON_URL] },
      text: "page text",
    };

    it("stores a saved page's site icon, as an icon, through the image fetcher", async () => {
      const asked: string[] = [];
      const { port } = await start({
        ...fakePipeline({
          extract: async () => PAGE_WITH_ICON,
          fetchImage: async (url) => {
            asked.push(url);
            return { kind: "ok", contentType: "image/png", bytes: new Uint8Array(png(128, 128)) };
          },
        }),
        imagePollMs: 20,
      });
      expect((await post(port, SAVE)).status).toBe(200);
      await until(() => images()[0]?.status === "ok", "a stored icon");
      expect(read<{ role: string }>("SELECT role FROM link_images")).toEqual([{ role: "icon" }]);
      expect(asked).toEqual([ICON_URL]);
    });

    it("records none for a saved page that names no picture, and fetches no image", async () => {
      const asked: string[] = [];
      const { port } = await start({
        ...fakePipeline({
          extract: async () => PAGE,
          fetchImage: async (url) => {
            asked.push(url);
            return PNG;
          },
        }),
        imagePollMs: 20,
      });
      expect((await post(port, SAVE)).status).toBe(200);
      await until(() => images()[0]?.status === "none", "the snapshot recorded");
      expect(images()).toEqual([{ status: "none", stored: 0 }]);
      expect(asked).toEqual([]);
    });

    it("answers save_link with the fetched page while the image fetch hangs", async () => {
      const fetching = gate();
      const pipeline = fakePipeline({
        extract: async () => PAGE_WITH_IMAGE,
        fetchImage: (_url, signal) =>
          new Promise<ImageOutcome>((resolve) => {
            fetching.open();
            signal?.addEventListener("abort", () => resolve({ kind: "aborted" }), { once: true });
          }),
      });
      const { port } = await start({ ...pipeline, imagePollMs: 20 });
      const res = await json(await post(port, SAVE));
      expect(res.result.structuredContent.link.snapshot).toMatchObject({
        status: "ok",
        imageUrl: IMAGE_URL,
      });
      await fetching.opened;
      expect(images()).toEqual([{ status: "pending", stored: 0 }]);
    });

    it("on stop, aborts an image fetch in flight and waits for it before closing the image fetcher, leaving it pending", async () => {
      await seed("https://example.com/backlog");
      const events: string[] = [];
      const pipeline = fakePipeline({ extract: async () => PAGE_WITH_IMAGE });
      const imageFetcher: ImageFetcher = {
        fetch: (_url, signal) =>
          new Promise<ImageOutcome>((resolve) => {
            events.push("fetching");
            signal?.addEventListener("abort", () =>
              setTimeout(() => {
                events.push("aborted");
                resolve({ kind: "aborted" });
              }, 20),
            );
          }),
        close: async () => void events.push("image fetcher closed"),
      };
      const { stop } = await start({ ...pipeline, imageFetcher, imagePollMs: 20 });
      await until(() => events.includes("fetching"), "an image fetch");
      await stop();
      expect(events).toEqual(["fetching", "aborted", "image fetcher closed"]);
      expect(images()).toEqual([{ status: "pending", stored: 0 }]);
    });
  });

  describe("the summary pass", () => {
    const PAGE_URL = "https://example.com/cats";
    /** A link whose page the server has read, holding a summary an AI wrote on its own. */
    const seedRead = async () => {
      const db = openDatabase(dbPath);
      try {
        const deps = createDeps(db, new FakeEmbedder(DIMS));
        const { link } = await saveLink(deps, "owner", {
          url: PAGE_URL,
          savedBy: "seed",
          summary: "Old words",
        });
        const now = deps.now();
        const lease = await deps.store.leaseSnapshot(
          "owner",
          link.id,
          now,
          new Date(now.getTime() + 100_000),
        );
        await deps.store.recordSnapshot(
          "owner",
          link.id,
          lease?.claim ?? -1,
          record({ imageUrl: null, text: "Cats live in Rome." }),
        );
      } finally {
        db.close();
      }
    };
    const held = () =>
      read<{ summary: string | null; source: string | null }>(
        "SELECT summary, summary_source AS source FROM links",
      );

    /** An OpenAI-style AI that records each request body, and answers `reply` or never. */
    const fakeAi = async (reply: string | null) => {
      const bodies: string[] = [];
      let closed = 0;
      const server = http.createServer((req, res) => {
        let body = "";
        req.on("data", (chunk) => {
          body += chunk;
        });
        req.on("end", () => {
          bodies.push(body);
          if (reply === null) return;
          res.setHeader("content-type", "application/json");
          res.end(
            JSON.stringify({
              choices: [{ message: { content: reply }, finish_reason: "stop" }],
            }),
          );
        });
        res.on("close", () => {
          closed++;
        });
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const port = (server.address() as net.AddressInfo).port;
      const ai = {
        api: "openai" as const,
        url: `http://127.0.0.1:${port}/v1`,
        key: undefined,
        model: "m",
        name: "Fake",
      };
      return {
        ai,
        bodies,
        closed: () => closed,
        close: async () => {
          server.closeAllConnections();
          await new Promise((resolve) => server.close(resolve));
        },
      };
    };

    const startWith = async (ai: ServerConfig["ai"]) => {
      const s = await startServer(
        { ...cfg(dbPath, 0), ...(ai && { ai }) },
        {
          ...fakePipeline(),
          settleMs: 200,
          requestLog: (line) => logged.push(line),
          summaryPollMs: 20,
          summaryGapMs: 0,
        },
      );
      started.push(s);
      return s;
    };

    it("writes the AI's summary of a read page, labelled as the server's", async () => {
      await seedRead();
      const fake = await fakeAi("A page about the cats of Rome");
      try {
        await startWith(fake.ai);
        await vi.waitFor(
          () =>
            expect(held()).toEqual([
              { summary: "A page about the cats of Rome", source: "server" },
            ]),
          { timeout: 3_000 },
        );
        expect(fake.bodies.join("\n")).toContain("Cats live in Rome.");
      } finally {
        await fake.close();
      }
    });

    it("on stop, aborts the call in flight and writes nothing", async () => {
      await seedRead();
      const fake = await fakeAi(null);
      try {
        const s = await startWith(fake.ai);
        await vi.waitFor(() => expect(fake.bodies).toHaveLength(1), { timeout: 3_000 });
        const stopAt = Date.now();
        await s.stop();
        expect(Date.now() - stopAt).toBeLessThan(2_000);
        await vi.waitFor(() => expect(fake.closed()).toBe(1), { timeout: 3_000 });
        expect(held()).toEqual([{ summary: "Old words", source: "inferred" }]);
        expect(fake.bodies).toHaveLength(1);
      } finally {
        await fake.close();
      }
    });

    it("with no AI set up, summarises nothing", async () => {
      await seedRead();
      await startWith(undefined);
      await sleep(300);
      expect(held()).toEqual([{ summary: "Old words", source: "inferred" }]);
    });
  });

  describe("the icon backfill", () => {
    const OLD = "https://example.com/old";
    const OLD_ICON = "https://example.com/old-icon.png";
    /** A link saved before icons were looked for: its snapshot is ok, names no preview, and its image status is NULL. */
    const seedLegacy = async (text: string | null = "old text") => {
      const db = openDatabase(dbPath);
      try {
        const deps = createDeps(db, new FakeEmbedder(DIMS));
        await saveLink(deps, "owner", { url: OLD, savedBy: "seed" });
        const id = String(db.prepare("SELECT id FROM links").pluck().get());
        const now = deps.now();
        const lease = await deps.store.leaseSnapshot(
          "owner",
          id,
          now,
          new Date(now.getTime() + 100_000),
        );
        expect(lease).not.toBeNull();
        await deps.store.recordSnapshot(
          "owner",
          id,
          lease?.claim ?? -1,
          record({ imageUrl: null, text }),
        );
        db.prepare("UPDATE snapshots SET image_status = NULL").run();
        return id;
      } finally {
        db.close();
      }
    };
    const iconRow = () =>
      read<{
        status: string | null;
        title: string | null;
        text: string | null;
        role: string | null;
      }>(
        `SELECT s.image_status AS status, s.title, s.text,
           (SELECT role FROM link_images WHERE link_id = s.link_id) AS role
         FROM snapshots s`,
      );

    it("gives a link saved before icons its site icon, through the page fetcher and the image pass", async () => {
      await seedLegacy();
      const pagesRead: string[] = [];
      const iconExtractor: PageExtractor = {
        extract: async (_html, finalUrl) => {
          pagesRead.push(finalUrl);
          return {
            kind: "ok",
            metadata: {
              title: "New title",
              description: null,
              imageUrl: null,
              iconUrls: [OLD_ICON],
            },
            text: "new text",
          };
        },
        close: async () => {},
      };
      const asked: string[] = [];
      await start({
        ...fakePipeline({
          fetchImage: async (url) => {
            asked.push(url);
            return { kind: "ok", contentType: "image/png", bytes: new Uint8Array(png(128, 128)) };
          },
        }),
        iconExtractor,
        iconPollMs: 20,
        imagePollMs: 20,
      });
      await until(() => iconRow()[0]?.role === "icon", "the backfilled icon");
      expect(pagesRead).toEqual([OLD]);
      expect(asked).toEqual([OLD_ICON]);
      expect(iconRow()).toEqual([
        { status: "ok", title: "Page title", text: "old text", role: "icon" },
      ]);
    });

    it("on stop, aborts the icon extraction in flight, records nothing, then closes the icon extractor", async () => {
      await seedLegacy();
      const events: string[] = [];
      let asked = false;
      const iconExtractor: PageExtractor = {
        extract: (_html, _url, signal) =>
          new Promise<ExtractOutcome>((resolve) => {
            asked = true;
            signal?.addEventListener(
              "abort",
              () => {
                events.push("aborted");
                resolve({ kind: "aborted" });
              },
              { once: true },
            );
          }),
        close: async () => void events.push("closed"),
      };
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      const { stop } = await start({ iconExtractor, iconPollMs: 20 });
      await until(() => asked, "the icon extraction");
      await stop();
      expect(events).toEqual(["aborted", "closed"]);
      expect(errors.mock.calls.flat().join("\n")).not.toContain("icon backfill still running");
      expect(iconRow()).toEqual([
        { status: null, title: "Page title", text: "old text", role: null },
      ]);
    });

    it("★ on stop, ends the backfill's page fetch before the fetcher closes, recording nothing", async () => {
      // No text, so the copy pass has no candidate: the backfill is the only one to fetch OLD.
      await seedLegacy(null);
      let asked = false;
      const pipeline = fakePipeline({
        fetch: (url, signal) => {
          if (url === OLD) asked = true;
          return hangUntilAborted(url, signal);
        },
      });
      const { stop } = await start({ ...pipeline, iconPollMs: 20 });
      await until(() => asked, "the backfill's page fetch");
      await stop();
      expect(iconRow()).toEqual([{ status: null, title: "Page title", text: null, role: null }]);
    });

    it("★ swaps a GitHub link's stored card of words for its icon; get_link and the export name no preview (#193)", async () => {
      // [A swap that never runs on a running server, or leaves the preview's address behind.]
      const GH = "https://github.com/Nostoi/aye-ai-ai-links";
      const CARD = "https://opengraph.githubassets.com/abc/Nostoi/aye-ai-ai-links";
      const FLUID = "https://github.com/fluidicon.png";
      const db = openDatabase(dbPath);
      let id: string;
      try {
        const deps = createDeps(db, new FakeEmbedder(DIMS));
        await saveLink(deps, "owner", { url: GH, savedBy: "seed" });
        id = String(db.prepare("SELECT id FROM links").pluck().get());
        const now = deps.now();
        const lease = await deps.store.leaseSnapshot("owner", id, now, at(1e9));
        await deps.store.recordSnapshot(
          "owner",
          id,
          lease?.claim ?? -1,
          record({ imageUrl: CARD }),
        );
        const card = { contentType: "image/png" as const, bytes: new Uint8Array(png(1200, 600)) };
        expect(await deps.images.writeImage("owner", id, CARD, "preview", card, now)).toBe(true);
      } finally {
        db.close();
      }
      const iconExtractor: PageExtractor = {
        extract: async () => ({
          kind: "ok",
          metadata: { title: "New", description: null, imageUrl: CARD, iconUrls: [FLUID] },
          text: "new text",
        }),
        close: async () => {},
      };
      const asked: string[] = [];
      const { port } = await start({
        ...fakePipeline({
          fetchImage: async (url) => {
            asked.push(url);
            return { kind: "ok", contentType: "image/png", bytes: new Uint8Array(png(512, 512)) };
          },
        }),
        iconExtractor,
        iconPollMs: 20,
        imagePollMs: 20,
      });
      await until(() => iconRow()[0]?.role === "icon", "the icon in place of the card");
      expect(asked).toEqual([FLUID]);
      expect(iconRow()).toEqual([
        { status: "ok", title: "Page title", text: "body text", role: "icon" },
      ]);
      const res = await json(
        await post(port, {
          jsonrpc: "2.0",
          id: 4,
          method: "tools/call",
          params: { name: "get_link", arguments: { id } },
        }),
      );
      expect(res.result.structuredContent.link.snapshot).toMatchObject({
        status: "ok",
        imageUrl: null,
      });
      const after = openDatabase(dbPath);
      try {
        const manifest = await exportManifest(createDeps(after, new FakeEmbedder(DIMS)), "owner");
        expect(manifest.links[0]?.page).toMatchObject({ title: "Page title", imageUrl: null });
      } finally {
        after.close();
      }
    });
  });

  describe("link checks", () => {
    const checkRows = () =>
      read<{ url: string; result: string; detail: string | null }>(
        `SELECT l.url, c.result, c.detail FROM link_checks c JOIN links l ON l.id = c.link_id
         ORDER BY l.id`,
      );

    /** A link saved eight days before now, so its first check is due as soon as the server starts. */
    const seedWeekOld = async (url: string) => {
      const db = openDatabase(dbPath);
      try {
        const deps = {
          ...createDeps(db, new FakeEmbedder(DIMS)),
          now: () => new Date(Date.now() - 8 * 86_400_000),
        };
        await saveLink(deps, "owner", { url, savedBy: "seed" });
      } finally {
        db.close();
      }
    };

    it("checks a link saved over a week ago in the background and records what it found", async () => {
      await seedWeekOld("https://example.com/old");
      const linkChecker: LinkChecker = {
        canResolve: async () => true,
        check: async () => ({ kind: "http_error", status: 404 }),
        close: async () => {},
      };
      await start({ linkChecker, checkPollMs: 20 });
      await until(() => checkRows().length === 1, "a recorded check");
      expect(checkRows()).toEqual([
        { url: "https://example.com/old", result: "dead", detail: "http:404" },
      ]);
    });

    it("closes the checker, and checks and records nothing, when startup fails after the runner is built", async () => {
      await seedWeekOld("https://example.com/old");
      const taken = net.createServer();
      await new Promise<void>((r) => taken.listen(0, "127.0.0.1", r));
      const port = (taken.address() as net.AddressInfo).port;
      const calls = { check: 0, close: 0 };
      const linkChecker: LinkChecker = {
        canResolve: async () => true,
        check: async (url) => {
          calls.check++;
          return { kind: "ok", finalUrl: url };
        },
        close: async () => void calls.close++,
      };
      try {
        await expect(
          startServer(cfg(dbPath, port), { ...fakePipeline(), linkChecker, checkPollMs: 20 }),
        ).rejects.toThrow(/EADDRINUSE/);
      } finally {
        await new Promise((r) => taken.close(r));
      }
      await sleep(100);
      expect(calls).toEqual({ check: 0, close: 1 });
      expect(checkRows()).toEqual([]);
    });

    it("on stop, aborts a check in flight and waits for it before closing the checker, writing nothing", async () => {
      await seedWeekOld("https://example.com/old");
      const events: string[] = [];
      const linkChecker: LinkChecker = {
        canResolve: async () => true,
        check: (_url, signal) =>
          new Promise<LinkCheckOutcome>((resolve) => {
            events.push("checking");
            signal?.addEventListener("abort", () =>
              setTimeout(() => {
                events.push("aborted");
                resolve({ kind: "aborted" });
              }, 20),
            );
          }),
        close: async () => void events.push("checker closed"),
      };
      const { stop } = await start({ linkChecker, checkPollMs: 20 });
      await until(() => events.includes("checking"), "a link check");
      await stop();
      expect(events).toEqual(["checking", "aborted", "checker closed"]);
      expect(checkRows()).toEqual([]);
    });
  });

  describe("the link purge", () => {
    const linkIds = () => read<{ id: number }>("SELECT id FROM links ORDER BY id").map((r) => r.id);
    const DELETED_AGO = 120_000;

    /** Saves links before the server starts and hides each one DELETED_AGO ms ago; the first keeps a copy. */
    const seedDeleted = async (urls: string[], withCopy = false) => {
      const db = openDatabase(dbPath);
      try {
        const deps = createDeps(db, new FakeEmbedder(DIMS), join(dir, "copies"));
        expect(await deps.savedCopies.checkFolder()).toEqual({ state: "ready" });
        const ids: string[] = [];
        for (const url of urls) {
          ids.push((await saveLink(deps, "owner", { url, savedBy: "seed" })).link.id);
        }
        const [first] = ids;
        if (withCopy && first !== undefined) {
          const draft = { markdown: "# body", imageUrls: [], nonce: "c".repeat(32) };
          expect(
            await deps.savedCopies.saveCopy("owner", first, draft, copyLimits(10_000), deps.now()),
          ).toBe("saved");
        }
        for (const id of ids) {
          expect(
            await deps.store.markDeleted("owner", id, new Date(Date.now() - DELETED_AGO)),
          ).toBe(true);
        }
        return ids;
      } finally {
        db.close();
      }
    };

    it("purges a link deleted over a minute before start, at start-up", async () => {
      await seedDeleted(["https://example.com/gone"]);
      expect(linkIds()).toHaveLength(1);
      await start();
      await until(() => linkIds().length === 0, "the purge");
    });

    it("purges a copy-less link on the timer while another waits on its copy", async () => {
      const [withCopy, bare] = await seedDeleted(
        ["https://example.com/with-copy", "https://example.com/bare"],
        true,
      );
      // The copy pass's first sweep retires the copy at once, so hold that back to keep the copy's files.
      await start({
        linkPurgeMs: 50,
        decorateDeps: (deps) => {
          vi.spyOn(deps.savedCopies, "purgeRemoved").mockResolvedValue(0);
          return deps;
        },
      });
      await until(() => !linkIds().includes(Number(bare)), "the copy-less link's purge");
      await sleep(500);
      expect(linkIds()).toEqual([Number(withCopy)]);
    });

    it("stops the purge timer before closing the database", async () => {
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      const { stop } = await start({ linkPurgeMs: 10 });
      await stop();
      await sleep(50);
      expect(errors.mock.calls.flat().join(" ")).not.toMatch(/link purge failed/);
    });
  });

  describe("meaning search", () => {
    const vectorCount = () => read<{ n: number }>("SELECT count(*) AS n FROM link_vectors")[0]?.n;

    it("D-T12: a saved link is found by a meaning-only query once the indexer has swept", async () => {
      await seed("https://example.com/backlog");
      const { port } = await start();
      await until(() => vectorCount() === 1, "a stored vector");
      const res = await json(
        await post(port, {
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: { name: "search_links", arguments: { query: "zebra" } },
        }),
      );
      expect(res.result.structuredContent.links.map((l: { url: string }) => l.url)).toEqual([
        "https://example.com/backlog",
      ]);
      expect(read("SELECT mode, meaning_candidates AS n FROM search_log")).toEqual([
        { mode: "hybrid", n: 1 },
      ]);
    });

    it("starts no sweep or embedding when a poll tick lands during the drain", async () => {
      await seed("https://example.com/backlog");
      const pipeline = fakePipeline();
      const embedded: string[][] = [];
      const embedder = {
        embedQuery: (t: string, s?: AbortSignal) => pipeline.embedder.embedQuery(t, s),
        embedDocuments: (texts: string[]) => {
          embedded.push(texts);
          return pipeline.embedder.embedDocuments(texts);
        },
      };
      const fast = gate();
      const slow = gate();
      const entered = { fast: gate(), slow: gate() };
      const holdBy = (deps: AppDeps) => {
        const store = Object.create(deps.store);
        store.insertIfAbsent = async (...args: Parameters<AppDeps["store"]["insertIfAbsent"]>) => {
          const which = args[1].url === "https://example.com/fast" ? "fast" : "slow";
          entered[which].open();
          await (which === "fast" ? fast : slow).opened;
          return deps.store.insertIfAbsent(...args);
        };
        return { ...deps, store };
      };
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        const { port, stop } = await start({
          ...pipeline,
          embedder,
          drainMs: 60_000,
          decorateDeps: holdBy,
        });
        while (vectorCount() !== 1) await new Promise((r) => setImmediate(r));
        const save = (url: string) =>
          post(port, {
            ...SAVE,
            params: { name: "save_link", arguments: { url } },
          });
        const saves = [save("https://example.com/fast"), save("https://example.com/slow")];
        await Promise.all([entered.fast.opened, entered.slow.opened]);
        const stopping = stop();
        fast.open();
        while (rows().length < 2) await new Promise((r) => setImmediate(r));
        await vi.advanceTimersByTimeAsync(15_000);
        for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
        expect(embedded).toHaveLength(1);
        expect(vectorCount()).toBe(1);
        slow.open();
        await stopping;
        await Promise.allSettled(saves);
      } finally {
        vi.useRealTimers();
      }
    });

    it("stops within the settle bound while a document embedding hangs, and embeds nothing more", async () => {
      await seed("https://example.com/one");
      await seed("https://example.com/two");
      const pipeline = fakePipeline();
      const calls: string[][] = [];
      const embedder = {
        embedQuery: (t: string, s?: AbortSignal) => pipeline.embedder.embedQuery(t, s),
        embedDocuments: (texts: string[]) => {
          calls.push(texts);
          return new Promise<Float32Array[]>(() => {});
        },
      };
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      const { stop } = await start({ ...pipeline, embedder });
      await until(() => calls.length === 1, "a document embedding");
      const started = performance.now();
      await stop();
      expect(performance.now() - started).toBeLessThan(2000);
      await sleep(50);
      expect(calls).toHaveLength(1);
      expect(vectorCount()).toBe(0);
      expect(errors.mock.calls.flat().join(" ")).toMatch(/indexer still running/);
    });
  });
});
