import { describe, expect, it } from "vitest";
import { createMetadataRefresher } from "./metadata-refresher.js";
import { createMetadataStash, FRESHNESS_MS, type JsonFetch } from "./metadata-stash.js";
import { CHATGPT_ID, chatgptDocument, otherClientDocument, signingKey } from "./oauth-test-kit.js";

const JWKS_URI = "https://chatgpt.com/oauth/test-client/jwks.json";
const MIN = 60_000;

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
    const stash = createMetadataStash({ fetch, now: c.now });
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
    const stash = createMetadataStash({ fetch });
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
    const stash = createMetadataStash({ fetch });
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
      const stash = createMetadataStash({ fetch: net.fetch });
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
    const stash = createMetadataStash({ fetch: async () => json(x.document, {}) });
    stash.sync(new Set());
    expect(await stash.refresh(x.id)).not.toBe("ok");
    expect(stash.isCurrent(x.id)).toBe(false);
  });
});
