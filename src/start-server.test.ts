import { existsSync, mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAgentKey } from "./auth/agent-keys.js";
import type { ExtractOutcome, PageExtractor } from "./core/extract.js";
import type { FetchOutcome, PageFetcher } from "./core/fetch.js";
import { saveLink } from "./core/links.js";
import { type AppDeps, createDeps } from "./deps.js";
import { type StartOptions, startServer } from "./start-server.js";
import { openDatabase } from "./store/database.js";
import { SqliteKeyStore } from "./store/key-store.js";

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
  metadata: { title: "Page title", description: null, imageUrl: null },
  text: "page text",
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
  return { fetcher, extractor, log, closed, fetched };
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
    });
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
      await saveLink(createDeps(db), "owner", { url, savedBy: "seed" });
    } finally {
      db.close();
    }
  };

  /** Starts with a fake pipeline unless the test passes one, so no test reaches the network. */
  const start = async (options: StartOptions = {}) => {
    const s = await startServer(
      { dbPath, port: 0 },
      { ...fakePipeline(), settleMs: 200, ...options },
    );
    started.push(s);
    return s;
  };

  it("saves through a real key over HTTP into the file database", async () => {
    const { port } = await start();
    const res = await post(port, SAVE);
    expect(res.status).toBe(200);
    expect(rows()).toEqual([{ url: URL_A, savedBy: "codex" }]);
  });

  it("refuses a request without a valid key and writes nothing", async () => {
    const { port } = await start();
    const res = await post(port, SAVE, "Bearer aak_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    expect(res.status).toBe(401);
    expect(rows()).toEqual([]);
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

  describe("page snapshots", () => {
    it("fetches a new link's page in the background and records it ok", async () => {
      const { port } = await start();
      expect((await post(port, SAVE)).status).toBe(200);
      await until(() => snapshots()[0]?.status === "ok", "an ok snapshot");
      expect(snapshots()).toMatchObject([
        { url: URL_A, status: "ok", attempts: 1, title: "Page title", text: "page text" },
      ]);
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
        await expect(startServer({ dbPath, port }, pipeline)).rejects.toThrow(/EADDRINUSE/);
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
});
