import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgentKey } from "./auth/agent-keys.js";
import type { AppDeps } from "./deps.js";
import { startServer } from "./start-server.js";
import { openDatabase } from "./store/database.js";
import { SqliteKeyStore } from "./store/key-store.js";

const SAVE = {
  jsonrpc: "2.0",
  id: 1,
  method: "tools/call",
  params: { name: "save_link", arguments: { url: "https://example.com/served" } },
};

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

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

  const rows = () => {
    const db = new Database(dbPath, { readonly: true });
    try {
      return db.prepare("SELECT url, saved_by AS savedBy FROM links").all();
    } finally {
      db.close();
    }
  };

  const start = async (decorateDeps?: (deps: AppDeps) => AppDeps, drainMs?: number) => {
    const s = await startServer(
      { dbPath, port: 0 },
      { ...(decorateDeps && { decorateDeps }), ...(drainMs !== undefined && { drainMs }) },
    );
    started.push(s);
    return s;
  };

  it("saves through a real key over HTTP into the file database", async () => {
    const { port } = await start();
    const res = await post(port, SAVE);
    expect(res.status).toBe(200);
    expect(rows()).toEqual([{ url: "https://example.com/served", savedBy: "codex" }]);
  });

  it("refuses a request without a valid key and writes nothing", async () => {
    const { port } = await start();
    const res = await post(port, SAVE, "Bearer aak_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    expect(res.status).toBe(401);
    expect(rows()).toEqual([]);
  });

  it("lets an in-flight request finish and commit before closing the database", async () => {
    const entered = gate();
    const release = gate();
    const { port, stop } = await start((deps) => {
      const store = Object.create(deps.store);
      store.insertIfAbsent = async (...args: Parameters<AppDeps["store"]["insertIfAbsent"]>) => {
        entered.open();
        await release.opened;
        return deps.store.insertIfAbsent(...args);
      };
      return { ...deps, store };
    });

    const inFlight = post(port, SAVE);
    await entered.opened;
    let stopped = false;
    const stopping = stop().then(() => {
      stopped = true;
    });
    await new Promise((r) => setTimeout(r, 150));
    expect(stopped).toBe(false);

    release.open();
    const res = await inFlight;
    await stopping;
    expect(res.status).toBe(200);
    expect(rows()).toEqual([{ url: "https://example.com/served", savedBy: "codex" }]);
  });

  it("refuses new connections once stopping", async () => {
    const entered = gate();
    const release = gate();
    const { port, stop } = await start((deps) => {
      const store = Object.create(deps.store);
      store.insertIfAbsent = async (...args: Parameters<AppDeps["store"]["insertIfAbsent"]>) => {
        entered.open();
        await release.opened;
        return deps.store.insertIfAbsent(...args);
      };
      return { ...deps, store };
    });
    const inFlight = post(port, SAVE);
    await entered.opened;
    const stopping = stop();
    await new Promise((r) => setTimeout(r, 50));
    await expect(post(port, SAVE)).rejects.toThrow();
    release.open();
    await inFlight;
    await stopping;
    expect(rows()).toHaveLength(1);
  });

  it("gives up on a request that outlasts the drain and still stops", async () => {
    const entered = gate();
    const never = new Promise<never>(() => {});
    const { port, stop } = await start((deps) => {
      const store = Object.create(deps.store);
      store.insertIfAbsent = async () => {
        entered.open();
        return never;
      };
      return { ...deps, store };
    }, 100);
    const inFlight = post(port, SAVE)
      .then((r) => r.text())
      .catch((e: unknown) => e);
    await entered.opened;
    await stop();
    expect(await inFlight).toBeInstanceOf(Error);
    expect(rows()).toEqual([]);
  });

  it("closes the database handle on stop, and stop can be called twice", async () => {
    const { stop } = await start();
    expect(existsSync(`${dbPath}-wal`)).toBe(true);
    await stop();
    expect(existsSync(`${dbPath}-wal`)).toBe(false);
    await expect(stop()).resolves.toBeUndefined();
  });
});
