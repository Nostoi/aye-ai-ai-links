import { describe, expect, it } from "vitest";
import { createMetadataRefresher } from "./metadata-refresher.js";
import { createMetadataStash, FRESHNESS_MS, type JsonFetch } from "./metadata-stash.js";
import { CHATGPT_ID, chatgptDocument, signingKey } from "./oauth-test-kit.js";

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
