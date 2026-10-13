import { afterEach, describe, expect, it, vi } from "vitest";
import { createAuthLock, insideAuthLock } from "./auth-lock.js";
import { createMetadataRefresher } from "./metadata-refresher.js";
import {
  createMetadataStash,
  FRESHNESS_MS,
  type JsonFetch,
  MAX_PENDING,
} from "./metadata-stash.js";
import { CHATGPT_ID, chatgptDocument, otherClientDocument, signingKey } from "./oauth-test-kit.js";

const JWKS_URI = "https://chatgpt.com/oauth/test-client/jwks.json";
const MIN = 60_000;

type StashOptions = { fetch: JsonFetch; now?: () => number };

/** A stash on its own auth lock, whose database holds exactly the set it was last synced with. */
function stashOn(options: StashOptions) {
  let db = new Set<string>();
  const stash = createMetadataStash({
    ...options,
    withAuthLock: createAuthLock(),
    isConnected: (id) => db.has(id),
  });
  return {
    ...stash,
    sync: (connected: Set<string>) => {
      db = new Set(connected);
      return stash.sync(connected);
    },
  };
}

function clock() {
  let t = 1_000_000;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

const json = (body: unknown, headers: Record<string, string>) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", ...headers },
  });

describe("the metadata stash", () => {
  it("counts a 304 as a successful fetch: it sends the validators, keeps the bodies and renews freshness", async () => {
    const c = clock();
    const keys = { keys: [signingKey("k1").jwk] };
    const seen: Array<{ url: string; headers: Record<string, string> }> = [];
    let unchanged = false;
    const fetch: JsonFetch = async (url, init) => {
      seen.push({ url, headers: init.headers });
      if (unchanged) return new Response(null, { status: 304 });
      if (url === CHATGPT_ID) return json(chatgptDocument(JWKS_URI), { etag: '"doc-1"' });
      return json(keys, { "last-modified": "Tue, 13 Oct 2026 00:00:00 GMT" });
    };
    const stash = stashOn({ fetch, now: c.now });
    stash.sync(new Set([CHATGPT_ID]));
    expect(await stash.refresh(CHATGPT_ID)).toBe("ok");

    c.advance(4 * MIN);
    unchanged = true;
    seen.length = 0;
    expect(await stash.refresh(CHATGPT_ID)).toBe("ok");
    expect(seen).toEqual([
      { url: CHATGPT_ID, headers: { accept: "application/json", "if-none-match": '"doc-1"' } },
      {
        url: JWKS_URI,
        headers: {
          accept: "application/json",
          "if-modified-since": "Tue, 13 Oct 2026 00:00:00 GMT",
        },
      },
    ]);

    c.advance(2 * MIN);
    expect(stash.isCurrent(CHATGPT_ID)).toBe(true);
    expect(await (await stash.transport(CHATGPT_ID)).json()).toEqual(chatgptDocument(JWKS_URI));
    expect(await (await stash.transport(JWKS_URI)).json()).toEqual(keys);

    c.advance(FRESHNESS_MS);
    expect(stash.isCurrent(CHATGPT_ID)).toBe(false);
    await expect(stash.transport(CHATGPT_ID)).rejects.toThrow();
  });

  /** A fetch that hangs until aborted, then settles 20 ms later. */
  function hangingNetwork() {
    const net = { signals: [] as AbortSignal[], settled: 0 };
    const fetch: JsonFetch = (_url, init) => {
      net.signals.push(init.signal);
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => {
          setTimeout(() => {
            net.settled++;
            reject(new Error("aborted"));
          }, 20);
        });
      });
    };
    return { net, fetch };
  }

  it("aborts a hanging fetch on close, waits for it to settle, and fetches nothing afterwards", async () => {
    const { net, fetch } = hangingNetwork();
    const stash = stashOn({ fetch });
    stash.sync(new Set([CHATGPT_ID]));
    const refreshing = stash.refresh(CHATGPT_ID);
    await Promise.resolve();
    expect(net.signals).toHaveLength(1);

    await stash.close();
    expect(net.signals[0]?.aborted).toBe(true);
    expect(net.settled).toBe(1);
    expect(await refreshing).toBe("failed");
    expect(await stash.refresh(CHATGPT_ID)).toBe("failed");
    expect(net.signals).toHaveLength(1);
  });

  it("stops the refresher only once a fill still running past its bound has been aborted and settled", async () => {
    const { net, fetch } = hangingNetwork();
    const stash = stashOn({ fetch });
    const refresher = createMetadataRefresher({
      stash,
      readConnected: async () => new Set([CHATGPT_ID]),
      fillBoundMs: 10,
      log: () => {},
    });
    await refresher.fill();
    expect(net.signals).toHaveLength(1);
    expect(net.settled).toBe(0);

    await refresher.stop();
    expect(net.signals[0]?.aborted).toBe(true);
    expect(net.settled).toBe(1);
  });
});

describe("pending clients", () => {
  /** A network whose fetches wait until the test releases them, in order. */
  function gatedNetwork(answers: Array<() => Response>) {
    const releases: Array<() => void> = [];
    let calls = 0;
    const fetch: JsonFetch = async () => {
      const answer = answers[calls++] ?? answers[answers.length - 1];
      await new Promise<void>((resolve) => releases.push(resolve));
      if (!answer) throw new Error("no answer");
      return answer();
    };
    return { fetch, releases };
  }

  it.each([
    ["fails first", [503, 200]],
    ["succeeds first", [200, 503]],
  ])(
    "never reports a concurrent prefetch as ok unless the client is pinned and current (%s)",
    async (_, statuses) => {
      const x = otherClientDocument(1);
      const net = gatedNetwork(
        statuses.map(
          (s) => () => (s === 200 ? json(x.document, {}) : new Response("", { status: s })),
        ),
      );
      const stash = stashOn({ fetch: net.fetch });
      const a = stash.prefetch(x.id);
      const b = stash.prefetch(x.id);
      await new Promise((r) => setTimeout(r, 10));
      net.releases[0]?.();
      const ra = await a;
      net.releases[1]?.();
      const rb = await b;
      const reportedOk = ra === "ok" || rb === "ok";
      expect(stash.isCurrent(x.id)).toBe(reportedOk);
      expect(stash.sync(new Set()), "a client reported ok stays pinned").toEqual(
        reportedOk ? [x.id] : [],
      );
    },
  );

  it("reports a refresh whose client is neither connected nor pinned as not ok, and keeps nothing", async () => {
    const x = otherClientDocument(2);
    const stash = stashOn({ fetch: async () => json(x.document, {}) });
    stash.sync(new Set());
    expect(await stash.refresh(x.id)).not.toBe("ok");
    expect(stash.isCurrent(x.id)).toBe(false);
  });
});

describe("refresh outcomes", () => {
  const V2 = "https://chatgpt.com/oauth/test-client/jwks-v2.json";

  function routed() {
    const routes = new Map<string, () => Response>();
    const urls: string[] = [];
    const fetch: JsonFetch = async (url) => {
      urls.push(url);
      const route = routes.get(url);
      return route ? route() : new Response("", { status: 404 });
    };
    return { routes, urls, fetch };
  }

  async function connectedChatgpt() {
    const c = clock();
    const net = routed();
    const keys = { keys: [signingKey("k1").jwk] };
    net.routes.set(CHATGPT_ID, () => json(chatgptDocument(JWKS_URI), {}));
    net.routes.set(JWKS_URI, () => json(keys, {}));
    const stash = stashOn({ fetch: net.fetch, now: c.now });
    stash.sync(new Set([CHATGPT_ID]));
    expect(await stash.refresh(CHATGPT_ID)).toBe("ok");
    return { c, net, keys, stash };
  }

  it.each([
    [
      "an invalid document",
      () => json({ ...chatgptDocument(JWKS_URI), client_id: "https://other.example/x" }, {}),
    ],
    [
      "a body that is not JSON",
      () =>
        new Response("<html></html>", { status: 200, headers: { "content-type": "text/html" } }),
    ],
  ])("drops the snapshot at once for %s", async (_, answer) => {
    const { net, stash } = await connectedChatgpt();
    net.routes.set(CHATGPT_ID, answer);
    expect(await stash.refresh(CHATGPT_ID)).toBe("gone");
    expect(stash.isCurrent(CHATGPT_ID)).toBe(false);
    await expect(stash.transport(CHATGPT_ID)).rejects.toThrow();
  });

  it.each([
    ["does not load", () => new Response("", { status: 503 })],
    ["is not a valid key set", () => json({ keys: [{ kty: "oct", k: "c2VjcmV0" }] }, {})],
  ])(
    "keeps the v1 snapshot until F when the document moves to a v2 key set that %s",
    async (_, answer) => {
      const { c, net, keys, stash } = await connectedChatgpt();
      net.routes.set(CHATGPT_ID, () => json(chatgptDocument(V2), {}));
      net.routes.set(V2, answer);
      c.advance(4 * MIN);
      expect(await stash.refresh(CHATGPT_ID)).toBe("failed");
      expect(stash.isCurrent(CHATGPT_ID)).toBe(true);
      expect(await (await stash.transport(CHATGPT_ID)).json()).toEqual(chatgptDocument(JWKS_URI));
      expect(await (await stash.transport(JWKS_URI)).json()).toEqual(keys);
      await expect(stash.transport(V2)).rejects.toThrow();
      c.advance(MIN);
      expect(stash.isCurrent(CHATGPT_ID)).toBe(false);
    },
  );

  it("does not take a 304 as success when it holds no earlier copy", async () => {
    const stash = stashOn({ fetch: async () => new Response(null, { status: 304 }) });
    stash.sync(new Set([CHATGPT_ID]));
    expect(await stash.refresh(CHATGPT_ID)).not.toBe("ok");
    expect(stash.isCurrent(CHATGPT_ID)).toBe(false);
  });

  it.each([
    "http://client.example/oauth/metadata.json",
    "https://user@client.example/oauth/metadata.json",
    "https://client.example/a/../metadata.json",
    "https://client.example/oauth/metadata.json#x",
    "https://127.0.0.1/oauth/metadata.json",
  ])("refuses to prefetch %s, fetching and pinning nothing", async (id) => {
    const net = routed();
    const stash = stashOn({ fetch: net.fetch });
    expect(await stash.prefetch(id)).toBe("refused");
    expect(net.urls).toEqual([]);
    expect(stash.sync(new Set())).toEqual([]);
  });
});

describe("a refresh that finishes after a disconnect (condition 11)", () => {
  const x = otherClientDocument(4);
  const doc = () => json(x.document, {});

  /** Every fetch waits until the test answers it, in order. */
  function heldNetwork() {
    const held: Array<(res: Response) => void> = [];
    const fetch: JsonFetch = () => new Promise((resolve) => held.push(resolve));
    const next = async () => {
      while (held.length === 0) await new Promise((r) => setTimeout(r, 0));
      return held.shift() as (res: Response) => void;
    };
    return { fetch, next };
  }

  /** A stash whose database is `db`, recording whether each connected check ran under the lock. */
  function world(db = new Set<string>()) {
    const net = heldNetwork();
    const withAuthLock = createAuthLock();
    const checks: boolean[] = [];
    const stash = createMetadataStash({
      fetch: net.fetch,
      withAuthLock,
      isConnected: (id) => {
        checks.push(insideAuthLock());
        return db.has(id);
      },
    });
    /** What disconnect does: the last consent goes and the stash forgets, in one lock section. */
    const disconnect = () =>
      withAuthLock(async () => {
        db.delete(x.id);
        stash.forget(x.id);
      });
    return { net, db, stash, checks, disconnect, withAuthLock };
  }

  it("drops a connected client's refresh that was in flight across its disconnect", async () => {
    const w = world(new Set([x.id]));
    w.stash.sync(new Set([x.id]));
    const refreshing = w.stash.refresh(x.id);
    const answer = await w.net.next();
    await w.disconnect();
    answer(doc());
    expect(await refreshing).toBe("dropped");
    expect(w.stash.isCurrent(x.id)).toBe(false);
  });

  it("drops a refresh for a client whose consent went since the last sync, checking under the lock", async () => {
    const w = world(new Set([x.id]));
    w.stash.sync(new Set([x.id]));
    const refreshing = w.stash.refresh(x.id);
    const answer = await w.net.next();
    w.db.delete(x.id);
    answer(doc());
    expect(await refreshing).toBe("dropped");
    expect(w.stash.isCurrent(x.id)).toBe(false);
    expect(w.checks).toEqual([true]);
  });

  it("drops the refresh of a client disconnected while still pinned from its connection", async () => {
    const w = world();
    const prefetching = w.stash.prefetch(x.id);
    (await w.net.next())(doc());
    expect(await prefetching).toBe("ok");
    w.db.add(x.id);
    const refreshing = w.stash.refresh(x.id);
    const answer = await w.net.next();
    await w.disconnect();
    answer(doc());
    expect(await refreshing).toBe("dropped");
    expect(w.stash.isCurrent(x.id)).toBe(false);
  });

  it("does not let an old refresh publish through a new connection's pin", async () => {
    const w = world(new Set([x.id]));
    w.stash.sync(new Set([x.id]));
    const old = w.stash.refresh(x.id);
    const answerOld = await w.net.next();
    await w.disconnect();
    const replacement = w.stash.prefetch(x.id);
    const answerReplacement = await w.net.next();
    answerOld(doc());
    expect(await old).toBe("dropped");
    expect(w.stash.isCurrent(x.id)).toBe(false);
    answerReplacement(new Response("", { status: 503 }));
    expect(await replacement).toBe("failed");
    expect(w.stash.isCurrent(x.id)).toBe(false);
  });

  it("does not let an old 404 erase the snapshot of a newer connection", async () => {
    const w = world(new Set([x.id]));
    w.stash.sync(new Set([x.id]));
    const old = w.stash.refresh(x.id);
    const answerOld = await w.net.next();
    await w.disconnect();
    const reconnecting = w.stash.prefetch(x.id);
    (await w.net.next())(doc());
    expect(await reconnecting).toBe("ok");
    w.db.add(x.id);
    answerOld(new Response("", { status: 404 }));
    expect(await old).toBe("dropped");
    expect(w.stash.isCurrent(x.id)).toBe(true);
  });

  it("still publishes a pending client's prefetch, which nobody has connected yet", async () => {
    const w = world();
    const prefetching = w.stash.prefetch(x.id);
    (await w.net.next())(doc());
    expect(await prefetching).toBe("ok");
    expect(w.stash.isCurrent(x.id)).toBe(true);
  });

  it("refuses forget outside the auth lock", async () => {
    const w = world();
    expect(() => w.stash.forget(x.id)).toThrow(/inside the auth lock/);
  });

  it("counts a forgotten client that is reconnecting as pending, like any new one", async () => {
    const others = [10, 11, 12, 13, 14].map(otherClientDocument);
    const docs = new Map([x, ...others].map((c) => [c.id, c.document]));
    const db = new Set([x.id]);
    const withAuthLock = createAuthLock();
    const stash = createMetadataStash({
      fetch: async (url) => json(docs.get(url), {}),
      withAuthLock,
      isConnected: (id) => db.has(id),
    });
    stash.sync(new Set([x.id]));
    for (const c of others.slice(0, MAX_PENDING - 1)) expect(await stash.prefetch(c.id)).toBe("ok");
    await withAuthLock(async () => {
      db.delete(x.id);
      stash.forget(x.id);
    });
    expect(await stash.prefetch(x.id)).toBe("ok");
    expect(await stash.prefetch((others[MAX_PENDING - 1] as { id: string }).id)).toBe("full");
  });
});

describe("the metadata refresher's schedule", () => {
  const LATENCY_MS = 200;
  const INTERVAL_MS = FRESHNESS_MS / 2;
  const RETRY_MS = 30_000;
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  afterEach(() => vi.useRealTimers());

  /** A network where every request takes LATENCY_MS and `answer` decides what comes back. */
  function network(answer: (url: string) => Response) {
    const net = { urls: [] as string[], fetch: undefined as unknown as JsonFetch };
    net.fetch = async (url) => {
      net.urls.push(url);
      await wait(LATENCY_MS);
      return answer(url);
    };
    return net;
  }

  const healthy = (url: string) =>
    url === CHATGPT_ID
      ? json(chatgptDocument(JWKS_URI), {})
      : json({ keys: [signingKey("k1").jwk] }, {});

  function connectedRefresher(
    net: { fetch: JsonFetch },
    readConnected: () => Promise<Set<string>> = async () => new Set([CHATGPT_ID]),
  ) {
    const stash = stashOn({ fetch: net.fetch });
    const refresher = createMetadataRefresher({ stash, readConnected, log: () => {} });
    return { stash, refresher };
  }

  it("never lets a connected client stop being current when one scheduled refresh fails", async () => {
    vi.useFakeTimers();
    let failing = false;
    const net = network((url) => (failing ? new Response("", { status: 503 }) : healthy(url)));
    const { stash, refresher } = connectedRefresher(net);
    await Promise.all([refresher.fill(), vi.advanceTimersByTimeAsync(2 * LATENCY_MS + 100)]);
    expect(stash.isCurrent(CHATGPT_ID)).toBe(true);
    refresher.start();

    const lapses: number[] = [];
    for (let elapsed = 0; elapsed < 2 * FRESHNESS_MS; elapsed += 1_000) {
      failing = elapsed >= INTERVAL_MS - 1_000 && elapsed < INTERVAL_MS + 2 * LATENCY_MS;
      await vi.advanceTimersByTimeAsync(1_000);
      if (!stash.isCurrent(CHATGPT_ID)) lapses.push(elapsed);
    }
    await refresher.stop();
    expect(lapses).toEqual([]);
  });

  it("makes a client current within the retry time after a failed startup fill", async () => {
    vi.useFakeTimers();
    let failing = true;
    const net = network((url) => (failing ? new Response("", { status: 503 }) : healthy(url)));
    const { stash, refresher } = connectedRefresher(net);
    await Promise.all([refresher.fill(), vi.advanceTimersByTimeAsync(LATENCY_MS + 100)]);
    expect(stash.isCurrent(CHATGPT_ID)).toBe(false);

    failing = false;
    refresher.start();
    await vi.advanceTimersByTimeAsync(RETRY_MS + 2 * LATENCY_MS + 100);
    expect(stash.isCurrent(CHATGPT_ID)).toBe(true);
    await refresher.stop();
  });

  it("waits the full interval when every result is ok or gone", async () => {
    vi.useFakeTimers();
    const OTHER_ID = "https://other.example/oauth/metadata.json";
    const net = network((url) =>
      url === OTHER_ID ? new Response("", { status: 404 }) : healthy(url),
    );
    const { refresher } = connectedRefresher(net, async () => new Set([CHATGPT_ID, OTHER_ID]));
    await Promise.all([refresher.fill(), vi.advanceTimersByTimeAsync(4 * LATENCY_MS)]);
    refresher.start();
    const afterFill = net.urls.length;

    await vi.advanceTimersByTimeAsync(RETRY_MS + 4 * LATENCY_MS);
    expect(net.urls.length).toBe(afterFill);
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(net.urls.length).toBeGreaterThan(afterFill);
    await refresher.stop();
  });

  it("comes back at the retry time when one client fails and another is healthy", async () => {
    vi.useFakeTimers();
    const OTHER_ID = "https://other.example/oauth/metadata.json";
    const net = network((url) =>
      url === OTHER_ID ? new Response("", { status: 503 }) : healthy(url),
    );
    const { refresher } = connectedRefresher(net, async () => new Set([CHATGPT_ID, OTHER_ID]));
    await Promise.all([refresher.fill(), vi.advanceTimersByTimeAsync(4 * LATENCY_MS)]);
    refresher.start();
    const afterFill = net.urls.length;

    await vi.advanceTimersByTimeAsync(RETRY_MS + 4 * LATENCY_MS);
    expect(net.urls.length).toBeGreaterThan(afterFill);
    await refresher.stop();
  });

  it("comes back at the retry time when reading the connected set fails, then makes the client current", async () => {
    vi.useFakeTimers();
    const net = network(healthy);
    let reads = 0;
    const { stash, refresher } = connectedRefresher(net, async () => {
      if (reads++ === 0) throw new Error("database busy");
      return new Set([CHATGPT_ID]);
    });
    await refresher.fill();
    expect(stash.isCurrent(CHATGPT_ID)).toBe(false);

    refresher.start();
    await vi.advanceTimersByTimeAsync(RETRY_MS + 2 * LATENCY_MS + 100);
    expect(reads).toBe(2);
    expect(stash.isCurrent(CHATGPT_ID)).toBe(true);
    await refresher.stop();
  });

  describe("stop", () => {
    async function stopAt(stopAtMs: number) {
      vi.useFakeTimers();
      const net = network(healthy);
      let reads = 0;
      let readsFinished = 0;
      const { refresher } = connectedRefresher(net, async () => {
        reads++;
        await wait(100);
        readsFinished++;
        return new Set([CHATGPT_ID]);
      });
      refresher.start();
      await vi.advanceTimersByTimeAsync(stopAtMs);
      let finishedAtStop = false;
      let readsAtStop = 0;
      const stopping = refresher.stop().then(() => {
        finishedAtStop = readsFinished === reads;
        readsAtStop = reads;
      });
      await vi.advanceTimersByTimeAsync(2 * LATENCY_MS + 100);
      await stopping;
      await vi.advanceTimersByTimeAsync(10 * FRESHNESS_MS);
      return { readsAtStop, readsAfter: reads - readsAtStop, finishedAtStop };
    }

    it("leaves no cycle running or armed when it arrives in the middle of one", async () => {
      const r = await stopAt(INTERVAL_MS + 50);
      expect(r.readsAtStop).toBe(1);
      expect(r.finishedAtStop).toBe(true);
      expect(r.readsAfter).toBe(0);
    });

    it("leaves no cycle armed when it arrives between cycles", async () => {
      const r = await stopAt(INTERVAL_MS - 1_000);
      expect(r.readsAtStop).toBe(0);
      expect(r.readsAfter).toBe(0);
    });
  });
});
