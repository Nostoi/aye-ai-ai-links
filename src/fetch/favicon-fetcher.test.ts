import type { LookupAddress } from "node:dns";
import http from "node:http";
import type { AddressInfo } from "node:net";
import zlib from "node:zlib";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeStore } from "../core/fake-store.js";
import { createFaviconPass } from "../core/favicon-pass.js";
import type { ImageFetcher, ImageOutcome } from "../core/fetch.js";
import { dib, ico, png, svg } from "../core/image-test-kit.js";
import { MAX_IMAGE_BYTES } from "../core/image-type.js";
import { at, newLink, record } from "../core/snapshot-store-contract.js";
import { isPublicAddress } from "./address-policy.js";
import { createFaviconFetcher } from "./favicon-fetcher.js";
import type { Resolve } from "./guarded-lookup.js";

/*
 * The layout of image-fetcher.test.ts. No test touches the network: `site` listens on ::1, which
 * the test policy treats as public; `target` listens on 127.0.0.1 and must never be reached.
 */
const names: Record<string, LookupAddress[]> = {
  "site.test": [{ address: "::1", family: 6 }],
  "evil.test": [{ address: "127.0.0.1", family: 4 }],
};
const resolve: Resolve = async (hostname) => {
  const found = names[hostname];
  if (!found) throw Object.assign(new Error(`no such host ${hostname}`), { code: "ENOTFOUND" });
  return found;
};
const allowSite = (ip: string) => ip === "::1" || isPublicAddress(ip);

const ENTRY = png(48, 48);
const ICO = ico([{ data: dib(16, 16) }, { data: ENTRY }]);
/** An ICO whose decoded body passes the cap: a valid PNG entry, then padding. */
const HUGE_ICO = Buffer.concat([ICO, Buffer.alloc(MAX_IMAGE_BYTES)]);

let target: http.Server;
let targetPort = 0;
let targetHits = 0;
let site: http.Server;
let sitePort = 0;
let lastAccept: string | undefined;

function handle(req: http.IncomingMessage, res: http.ServerResponse) {
  lastAccept = req.headers.accept;
  const send = (type: string, body: Buffer, extra: http.OutgoingHttpHeaders = {}) => {
    res.writeHead(200, { "content-type": type, ...extra });
    res.end(body);
  };
  switch (req.url) {
    case "/x-icon":
      return send("image/x-icon", ICO);
    case "/ms-icon":
      return send("image/vnd.microsoft.icon", ICO);
    case "/octet":
      return send("application/octet-stream", ICO);
    case "/html-ico":
      return send("text/html", ICO);
    case "/text-ico":
      return send("text/plain", ICO);
    case "/favicon.ico":
      // A soft 404: the site's error page, labelled as an icon.
      return send("image/x-icon", Buffer.from("<!doctype html><title>Not found</title><p>Nope"));
    case "/html-png":
      return send("text/html", png(32, 32));
    case "/bmp-only":
      return send("image/x-icon", ico([{ data: dib(32, 32) }]));
    case "/cursor":
      return send("image/x-icon", ico([{ data: ENTRY }], { type: 2 }));
    case "/png":
      return send("image/png", png(32, 32));
    case "/svg":
      return send("image/png", svg);
    case "/big":
      return send("image/x-icon", HUGE_ICO);
    case "/bomb":
      return send("image/x-icon", zlib.gzipSync(HUGE_ICO), { "content-encoding": "gzip" });
    case "/r-loopback":
      res.writeHead(302, { location: `http://127.0.0.1:${targetPort}/x-icon` });
      return res.end();
    case "/r-name":
      res.writeHead(302, { location: `http://evil.test:${targetPort}/x-icon` });
      return res.end();
    case "/r-ico":
      res.writeHead(301, { location: "/x-icon" });
      return res.end();
    default:
      res.writeHead(404);
      return res.end();
  }
}

const listen = (server: http.Server, host: string): Promise<number> =>
  new Promise((done, fail) => {
    server.once("error", fail);
    server.listen(0, host, () => done((server.address() as AddressInfo).port));
  });

const close = (server: http.Server): Promise<void> => {
  server.closeAllConnections();
  return new Promise((done) => server.close(() => done()));
};

beforeAll(async () => {
  target = http.createServer((_req, res) => {
    targetHits++;
    res.writeHead(200, { "content-type": "image/x-icon" });
    res.end(ICO);
  });
  targetPort = await listen(target, "127.0.0.1");
  site = http.createServer(handle);
  sitePort = await listen(site, "::1");
});

afterAll(async () => {
  await Promise.all([target, site].map(close));
});

beforeEach(() => {
  targetHits = 0;
});

const open: ImageFetcher[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((f) => f.close()));
});

const fetchPath = (path: string): Promise<ImageOutcome> => {
  const f = createFaviconFetcher({ version: "v2099.01.02", resolve, isAllowed: allowSite });
  open.push(f);
  return f.fetch(`http://site.test:${sitePort}${path}`);
};

describe("the favicon fetcher (#272)", () => {
  it.each([
    ["image/x-icon", "/x-icon"],
    ["image/vnd.microsoft.icon", "/ms-icon"],
    ["application/octet-stream", "/octet"],
    ["text/html", "/html-ico"],
    ["text/plain", "/text-ico"],
    ["image/x-icon after a redirect", "/r-ico"],
  ])(
    "★ keeps the PNG entry of an ICO served as %s, as image/png, with only its bytes",
    async (_, path) => {
      // [ImageFetcher's checkImage refuses the ICO as not_image; deciding ICO by Content-Type refuses text/*.]
      const outcome = await fetchPath(path);
      expect(outcome).toEqual({
        kind: "ok",
        contentType: "image/png",
        bytes: new Uint8Array(ENTRY),
      });
    },
  );

  it("★ asks for icon types too", async () => {
    await fetchPath("/x-icon");
    expect(lastAccept).toMatch(/(^|,)image\/x-icon[,;]/);
    expect(lastAccept).toMatch(/(^|,)image\/vnd\.microsoft\.icon[,;]/);
  });

  it("keeps any other picture through checkImage, as the image fetcher does", async () => {
    expect(await fetchPath("/png")).toEqual({
      kind: "ok",
      contentType: "image/png",
      bytes: new Uint8Array(png(32, 32)),
    });
    expect(await fetchPath("/svg")).toMatchObject({ kind: "not_image" });
  });

  it.each([
    ["a BMP-only ICO", "/bmp-only", "image/x-icon"],
    ["a cursor", "/cursor", "image/x-icon"],
    ["a soft-404 HTML page served as image/x-icon", "/favicon.ico", "image/x-icon"],
    ["a PNG served as text/html: only an ICO is decided by its bytes", "/html-png", "text/html"],
  ])("refuses %s as not_image", async (_, path, contentType) => {
    expect(await fetchPath(path)).toEqual({ kind: "not_image", contentType });
  });

  it("★ stores nothing for a soft-404 /favicon.ico: the favicon pass ends it as none", async () => {
    // [Storing the error page's bytes because the server called them an icon.]
    const store = new FakeStore();
    const { link } = await store.insertIfAbsent("o", newLink(1, at(0)));
    const lease = await store.leaseSnapshot("o", link.id, at(1), at(100));
    const url = `http://site.test:${sitePort}/favicon.ico`;
    const r = record({ imageUrl: null, faviconUrls: [url] });
    expect(await store.recordSnapshot("o", link.id, lease?.claim ?? -1, r)).toBe(true);
    const fetcher = createFaviconFetcher({ version: "v1", resolve, isAllowed: allowSite });
    open.push(fetcher);
    const pass = createFaviconPass({ store, fetcher, now: () => at(2), log: () => {} });
    await pass.sweep();
    await pass.stop();
    expect(store.faviconRow("o", link.id)).toMatchObject({ status: "none", stored: false });
    expect(await store.favicon("o", link.id)).toBe(null);
  });

  it.each([
    ["an ICO past the 2 MiB cap", "/big"],
    ["a gzipped ICO whose decoded body passes the cap", "/bomb"],
  ])("refuses %s as too_large, before the parser sees it", async (_, path) => {
    expect(await fetchPath(path)).toEqual({ kind: "too_large" });
  });

  it.each([
    ["to a loopback IP", "/r-loopback"],
    ["to a name that resolves to loopback", "/r-name"],
  ])("refuses a redirect %s, never reaching it", async (_, path) => {
    expect(await fetchPath(path)).toEqual({ kind: "refused", reason: "address" });
    expect(targetHits).toBe(0);
  });
});
