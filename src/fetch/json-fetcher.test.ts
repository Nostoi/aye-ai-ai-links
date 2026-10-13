import type { LookupAddress } from "node:dns";
import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
import zlib from "node:zlib";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { isPublicAddress } from "./address-policy.js";
import type { Resolve } from "./guarded-lookup.js";
import { createJsonFetcher, type JsonFetcherOptions } from "./json-fetcher.js";

/*
 * Test layout. No test touches the network, and https stays enforced.
 *
 * - `target` listens on 127.0.0.1 and must never be reached: its hit counter is asserted to be 0.
 * - `site` listens on ::1, which the test policy treats as an "allowed public" address. A fake
 *   resolver maps site.test to it. The address policy is the only thing that tells ::1 from 127.0.0.1.
 * - Both serve a self-signed, test-only certificate (fixtures/test-tls-*.pem) that the fetcher
 *   trusts through its `ca` option.
 */
const cert = fs.readFileSync(new URL("./fixtures/test-tls-cert.pem", import.meta.url));
const key = fs.readFileSync(new URL("./fixtures/test-tls-key.pem", import.meta.url));

const V4_LOOPBACK: LookupAddress = { address: "127.0.0.1", family: 4 };
const V6_LOOPBACK: LookupAddress = { address: "::1", family: 6 };
const PRIVATE_10: LookupAddress = { address: "10.0.0.5", family: 4 };

const names: Record<string, LookupAddress[]> = {
  "site.test": [V6_LOOPBACK],
  "evil.test": [V4_LOOPBACK],
  "lan.test": [PRIVATE_10],
};

const resolve: Resolve = async (hostname) => {
  const found = names[hostname];
  if (!found) throw Object.assign(new Error(`no such host ${hostname}`), { code: "ENOTFOUND" });
  return found;
};

const allowSite = (ip: string) => ip === "::1" || isPublicAddress(ip);

const CAP = 64 * 1024;

let target: https.Server;
let targetPort = 0;
let targetHits = 0;

let site: https.Server;
let sitePort = 0;
let siteHits: string[] = [];
let lastHeaders: IncomingMessage["headers"] = {};

function handle(req: IncomingMessage, res: ServerResponse) {
  const path = req.url ?? "/";
  siteHits.push(path);
  lastHeaders = req.headers;
  const [, kind = "", arg = "", mode = ""] = path.split("/");
  const type = { "content-type": "application/json" };

  switch (kind) {
    case "doc":
      res.writeHead(200, {
        ...type,
        etag: '"v1"',
        vary: "*",
        "cache-control": "max-age=60",
        "set-cookie": "sid=1",
        "x-custom": "kept",
      });
      return res.end(JSON.stringify({ ok: true }));
    case "etag":
      if (req.headers["if-none-match"] === '"v1"') {
        res.writeHead(304, { etag: '"v1"', vary: "Accept" });
        return res.end();
      }
      res.writeHead(200, { ...type, etag: '"v1"' });
      return res.end(JSON.stringify({ ok: true }));
    case "echo":
      res.writeHead(200, type);
      return res.end(JSON.stringify(req.headers));
    case "r":
      res.writeHead(302, { location: `https://evil.test:${targetPort}/` });
      return res.end("moved");
    case "empty":
      res.writeHead(Number(arg));
      return res.end();
    case "size": {
      // mode is "plain" or "gzip"; a "-chunked" suffix sends it without Content-Length.
      const raw = Buffer.alloc(Number(arg), 0x20);
      const gz = mode.startsWith("gzip");
      const body = gz ? zlib.gzipSync(raw) : raw;
      res.writeHead(200, gz ? { ...type, "content-encoding": "gzip" } : type);
      if (mode.endsWith("chunked")) {
        res.write(body.subarray(0, 10));
        return res.end(body.subarray(10));
      }
      return res.end(body);
    }
    case "hang":
      return; // never answers
    case "stall":
      res.writeHead(200, type);
      return void res.write("{");
    default:
      res.writeHead(404, type);
      return res.end("{}");
  }
}

const listen = (server: https.Server, host: string) =>
  new Promise<number>((done, fail) => {
    server.once("error", fail);
    server.listen(0, host, () => done((server.address() as AddressInfo).port));
  });

const closeServer = (server: https.Server) => {
  server.closeAllConnections();
  return new Promise<void>((done) => server.close(() => done()));
};

beforeAll(async () => {
  target = https.createServer({ cert, key }, (_req, res) => {
    targetHits++;
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"secret":true}');
  });
  targetPort = await listen(target, "127.0.0.1");
  site = https.createServer({ cert, key }, handle);
  sitePort = await listen(site, "::1");
});

afterAll(async () => {
  await Promise.all([closeServer(target), closeServer(site)]);
});

beforeEach(() => {
  targetHits = 0;
  siteHits = [];
  lastHeaders = {};
});

const open: Array<{ close: () => Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((f) => f.close()));
});

function fetcherWith(options: JsonFetcherOptions = {}) {
  const fetcher = createJsonFetcher({ resolve, isAllowed: allowSite, ca: cert, ...options });
  open.push(fetcher);
  return fetcher;
}
const siteUrl = (path: string) => `https://site.test:${sitePort}${path}`;

describe("addresses that must never be connected to", () => {
  it.each([
    ["127.0.0.1", "evil.test"],
    ["10.0.0.5", "lan.test"],
  ])("refuses a hostname that resolves to %s, with no connection", async (_ip, host) => {
    await expect(fetcherWith().fetch(`https://${host}:${targetPort}/`)).rejects.toThrow();
    expect(targetHits).toBe(0);
  });

  it.each(["https://127.0.0.1", "https://[::1]"])("refuses the literal %s", async (origin) => {
    // The test policy would allow ::1, so this one uses the real policy.
    const fetcher = createJsonFetcher({ ca: cert });
    open.push(fetcher);
    await expect(fetcher.fetch(`${origin}:${targetPort}/`)).rejects.toThrow(/address/);
    expect(targetHits).toBe(0);
    expect(siteHits).toEqual([]);
  });

  it("refuses http:", async () => {
    await expect(fetcherWith().fetch(`http://site.test:${sitePort}/doc`)).rejects.toThrow(/https/);
    expect(siteHits).toEqual([]);
  });

  it("refuses credentials in the URL", async () => {
    await expect(fetcherWith().fetch(`https://user:pw@site.test:${sitePort}/doc`)).rejects.toThrow(
      /credentials/,
    );
    expect(siteHits).toEqual([]);
  });

  it("refuses a string that is not a URL", async () => {
    await expect(fetcherWith().fetch("not a url")).rejects.toThrow();
  });
});

describe("redirects", () => {
  it("returns a 302 as itself and never requests its target", async () => {
    const res = await fetcherWith().fetch(siteUrl("/r"));
    expect(res.status).toBe(302);
    expect(res.redirected).toBe(false);
    expect(res.headers.get("location")).toBe(`https://evil.test:${targetPort}/`);
    expect(targetHits).toBe(0);
    expect(siteHits).toEqual(["/r"]);
  });
});

describe("body size", () => {
  it.each(["plain", "gzip", "plain-chunked", "gzip-chunked"])(
    "accepts %s at the cap and refuses one byte over",
    async (mode) => {
      const fetcher = fetcherWith();
      const ok = await fetcher.fetch(siteUrl(`/size/${CAP}/${mode}`));
      expect((await ok.arrayBuffer()).byteLength).toBe(CAP);
      await expect(fetcher.fetch(siteUrl(`/size/${CAP + 1}/${mode}`))).rejects.toThrow();
    },
  );

  it("counts decoded bytes, so a tiny compressed bomb is refused", async () => {
    // 20 MB of spaces gzips to a few KB, far under the cap on the wire.
    await expect(fetcherWith().fetch(siteUrl("/size/20000000/gzip"))).rejects.toThrow();
  });
});

describe("deadline and cancellation", () => {
  const DEADLINE = 300;
  const SLACK = 1000;

  async function timed(promise: Promise<unknown>) {
    const started = performance.now();
    const result = await promise.then(
      () => "resolved",
      (err: unknown) => err,
    );
    return { result, elapsed: performance.now() - started };
  }

  it.each(["/hang", "/stall"])("rejects at the deadline when %s never finishes", async (path) => {
    const fetcher = fetcherWith({ limits: { deadlineMs: DEADLINE } });
    const { result, elapsed } = await timed(fetcher.fetch(siteUrl(path)));
    expect(result).toBeInstanceOf(Error);
    expect(elapsed).toBeGreaterThanOrEqual(DEADLINE - 50);
    expect(elapsed).toBeLessThan(DEADLINE + SLACK);
  });

  it("rejects at the deadline when DNS never answers", async () => {
    const fetcher = fetcherWith({
      resolve: () => new Promise(() => {}),
      limits: { deadlineMs: DEADLINE },
    });
    const { result, elapsed } = await timed(fetcher.fetch(siteUrl("/doc")));
    expect(result).toBeInstanceOf(Error);
    expect(elapsed).toBeLessThan(DEADLINE + SLACK);
  });

  it("rejects promptly when the caller cancels during DNS", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    const fetcher = fetcherWith({ resolve: () => new Promise(() => {}) });
    const { result, elapsed } = await timed(
      fetcher.fetch(siteUrl("/doc"), { signal: controller.signal }),
    );
    expect(result).toBeInstanceOf(Error);
    expect(elapsed).toBeLessThan(SLACK);
  });

  it("honours the signal of a Request input", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    const { result, elapsed } = await timed(
      fetcherWith().fetch(new Request(siteUrl("/hang"), { signal: controller.signal })),
    );
    expect(result).toBeInstanceOf(Error);
    expect(elapsed).toBeLessThan(SLACK);
  });

  it("rejects without a request for a signal that is already cancelled", async () => {
    await expect(
      fetcherWith().fetch(siteUrl("/doc"), { signal: AbortSignal.abort() }),
    ).rejects.toThrow();
    expect(siteHits).toEqual([]);
  });
});

describe("request headers", () => {
  it("forwards Accept, If-None-Match and If-Modified-Since only, with its own User-Agent", async () => {
    await fetcherWith().fetch(siteUrl("/echo"), {
      headers: {
        Accept: "application/json",
        "If-None-Match": '"x"',
        "If-Modified-Since": "Wed, 21 Oct 2015 07:28:00 GMT",
        Cookie: "sid=secret",
        Authorization: "Bearer secret",
        "X-Other": "no",
        "User-Agent": "caller-agent",
      },
    });
    expect(lastHeaders.accept).toBe("application/json");
    expect(lastHeaders["if-none-match"]).toBe('"x"');
    expect(lastHeaders["if-modified-since"]).toBe("Wed, 21 Oct 2015 07:28:00 GMT");
    expect(lastHeaders.cookie).toBeUndefined();
    expect(lastHeaders.authorization).toBeUndefined();
    expect(lastHeaders["x-other"]).toBeUndefined();
    expect(String(lastHeaders["user-agent"])).toMatch(/aye-ai-ai-links/);
  });

  it("takes its headers from a Request input", async () => {
    const res = await fetcherWith().fetch(
      new Request(siteUrl("/etag"), {
        headers: { "If-None-Match": '"v1"', Cookie: "sid=secret" },
      }),
    );
    expect(res.status).toBe(304);
    expect(lastHeaders["if-none-match"]).toBe('"v1"');
    expect(lastHeaders.cookie).toBeUndefined();
  });
});

describe("responses", () => {
  it("passes upstream headers through except set-cookie, and keeps Vary and Cache-Control", async () => {
    const res = await fetcherWith().fetch(siteUrl("/doc"));
    expect(res.status).toBe(200);
    expect(res.redirected).toBe(false);
    expect(res.headers.get("vary")).toBe("*");
    expect(res.headers.get("cache-control")).toBe("max-age=60");
    expect(res.headers.get("etag")).toBe('"v1"');
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(res.headers.get("x-custom")).toBe("kept");
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(await res.json()).toEqual({ ok: true });
  });

  it("drops content-encoding and content-length because the body is decoded", async () => {
    const res = await fetcherWith().fetch(siteUrl("/size/100/gzip"));
    expect(res.headers.get("content-encoding")).toBeNull();
    expect(res.headers.get("content-length")).toBeNull();
    expect((await res.arrayBuffer()).byteLength).toBe(100);
  });

  it("returns a 304 with a null body and keeps its etag and Vary", async () => {
    const res = await fetcherWith().fetch(siteUrl("/etag"), {
      headers: { "If-None-Match": '"v1"' },
    });
    expect(res.status).toBe(304);
    expect(res.body).toBeNull();
    expect(res.headers.get("etag")).toBe('"v1"');
    expect(res.headers.get("vary")).toBe("Accept");
  });

  it.each([204, 205])("returns a %i with a null body", async (status) => {
    const res = await fetcherWith().fetch(siteUrl(`/empty/${status}`));
    expect(res.status).toBe(status);
    expect(res.body).toBeNull();
  });

  it("accepts a URL object", async () => {
    const res = await fetcherWith().fetch(new URL(siteUrl("/doc")));
    expect(res.status).toBe(200);
  });
});

describe("close()", () => {
  it("makes later fetches fail without a request", async () => {
    const fetcher = fetcherWith();
    await fetcher.close();
    await expect(fetcher.fetch(siteUrl("/doc"))).rejects.toThrow();
    expect(siteHits).toEqual([]);
  });
});
