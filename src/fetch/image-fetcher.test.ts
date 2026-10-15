import type { LookupAddress } from "node:dns";
import http from "node:http";
import type { AddressInfo } from "node:net";
import zlib from "node:zlib";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ImageFetcher, ImageOutcome } from "../core/fetch.js";
import { isPublicAddress } from "./address-policy.js";
import type { Resolve } from "./guarded-lookup.js";
import { createImageFetcher, MAX_IMAGE_BYTES } from "./image-fetcher.js";
import { gif, png, svg } from "./image-test-kit.js";

/*
 * The layout of guarded-fetcher.test.ts. No test touches the network.
 *
 * - `target` listens on 127.0.0.1 and must never be reached: its hit counter is asserted to be 0.
 * - `site` listens on ::1, which the test policy treats as public. A fake resolver maps
 *   site.test to it.
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

const PNG = png(640, 480);
const bomb = zlib.gzipSync(Buffer.alloc(20_000_000, 0));

let target: http.Server;
let targetPort = 0;
let targetHits = 0;
let site: http.Server;
let sitePort = 0;
const VERSION = "v2099.01.02";
let lastAccept: string | undefined;
let lastUserAgent: string | undefined;

function handle(req: http.IncomingMessage, res: http.ServerResponse) {
  lastAccept = req.headers.accept;
  lastUserAgent = req.headers["user-agent"];
  const send = (type: string | null, body: Buffer, extra: http.OutgoingHttpHeaders = {}) => {
    res.writeHead(200, type === null ? extra : { "content-type": type, ...extra });
    res.end(body);
  };
  const [, kind = ""] = (req.url ?? "/").split("/");
  switch (kind) {
    case "png":
      return send("image/png", PNG);
    case "png-as-octet":
      return send("application/octet-stream", PNG);
    case "gif-as-png":
      return send("image/png", gif(10, 10));
    case "png-untyped":
      return send(null, PNG);
    case "png-as-html":
      return send("text/html", PNG);
    case "gif-huge-frame":
      return send(
        "image/gif",
        gif(1, 1, { frame: { left: 0, top: 0, width: 20_000, height: 20_000 } }),
      );
    case "svg-as-png":
      return send("image/png", svg);
    case "svg":
      return send("image/svg+xml", svg);
    case "html":
      return send("text/html", Buffer.from("<!doctype html><p>not an image"));
    case "html-as-png":
      return send("image/png", Buffer.from("<!doctype html><p>not an image"));
    case "huge-pixels":
      return send("image/png", png(100_000, 100_000));
    case "cut-header":
      return send("image/png", PNG.subarray(0, 20));
    case "big":
      return send("image/png", Buffer.concat([PNG, Buffer.alloc(3 * 1024 * 1024)]));
    case "exact":
      return send("image/png", Buffer.concat([PNG, Buffer.alloc(MAX_IMAGE_BYTES - PNG.length)]));
    case "bomb":
      return send("image/png", bomb, { "content-encoding": "gzip" });
    case "gzip":
      return send("image/png", zlib.gzipSync(PNG), { "content-encoding": "gzip" });
    case "r-loopback":
      res.writeHead(302, { location: `http://127.0.0.1:${targetPort}/` });
      return res.end();
    case "r-name":
      res.writeHead(302, { location: `http://evil.test:${targetPort}/` });
      return res.end();
    case "r-link-local":
      res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" });
      return res.end();
    case "r-png":
      res.writeHead(301, { location: "/png" });
      return res.end();
    case "unavailable":
      res.writeHead(503, { "content-type": "image/png" });
      return res.end(PNG);
    default:
      res.writeHead(404);
      return res.end();
  }
}

function listen(server: http.Server, host: string): Promise<number> {
  return new Promise((done, fail) => {
    server.once("error", fail);
    server.listen(0, host, () => done((server.address() as AddressInfo).port));
  });
}

function close(server: http.Server): Promise<void> {
  server.closeAllConnections();
  return new Promise((done) => server.close(() => done()));
}

beforeAll(async () => {
  target = http.createServer((_req, res) => {
    targetHits++;
    res.writeHead(200, { "content-type": "image/png" });
    res.end(PNG);
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
function fetcher(): ImageFetcher {
  const f = createImageFetcher({ version: VERSION, resolve, isAllowed: allowSite });
  open.push(f);
  return f;
}
afterEach(async () => {
  await Promise.all(open.splice(0).map((f) => f.close()));
});

const fetchPath = (path: string): Promise<ImageOutcome> =>
  fetcher().fetch(`http://site.test:${sitePort}${path}`);

describe("an image on an allowed address", () => {
  it("is returned with the type its magic bytes name, and the image types are asked for", async () => {
    const outcome = await fetchPath("/png");
    expect(outcome).toEqual({ kind: "ok", contentType: "image/png", bytes: new Uint8Array(PNG) });
    expect(lastAccept).toBe("image/webp,image/png,image/jpeg,image/gif;q=0.9");
  });

  it("names the deployed version in its User-Agent", async () => {
    await fetchPath("/png");
    expect(lastUserAgent).toBe(
      `aye-ai-ai-links/${VERSION} (personal link library; fetches pages its owner saved)`,
    );
  });

  it("is typed by its bytes, not the server's header", async () => {
    expect(await fetchPath("/gif-as-png")).toMatchObject({ kind: "ok", contentType: "image/gif" });
  });

  it("is accepted when the server calls it application/octet-stream", async () => {
    expect(await fetchPath("/png-as-octet")).toMatchObject({
      kind: "ok",
      contentType: "image/png",
    });
  });

  it("is decoded from gzip", async () => {
    expect(await fetchPath("/gzip")).toMatchObject({ kind: "ok", bytes: new Uint8Array(PNG) });
  });

  it("follows a redirect to a public address", async () => {
    expect(await fetchPath("/r-png")).toMatchObject({ kind: "ok" });
  });

  it("is allowed at exactly the byte cap", async () => {
    expect(await fetchPath("/exact")).toMatchObject({ kind: "ok" });
  });
});

describe("what is not kept", () => {
  it.each([
    ["an SVG served as image/png", "/svg-as-png"],
    ["HTML served as image/png", "/html-as-png"],
    ["a PNG header cut short", "/cut-header"],
  ])("refuses %s as not_image", async (_, path) => {
    expect(await fetchPath(path)).toMatchObject({ kind: "not_image" });
  });

  it.each([
    ["an SVG", "/svg", "image/svg+xml"],
    ["an HTML page", "/html", "text/html"],
    ["an untyped body", "/png-untyped", ""],
    ["a real PNG served as text/html", "/png-as-html", "text/html"],
  ])("refuses %s as not_image, reporting the server's type", async (_, path, contentType) => {
    expect(await fetchPath(path)).toEqual({ kind: "not_image", contentType });
  });

  it("refuses a 3 MB image as too_large", async () => {
    expect(await fetchPath("/big")).toEqual({ kind: "too_large" });
  });

  it("refuses a gzip bomb as too_large, counting decoded bytes", async () => {
    expect(await fetchPath("/bomb")).toEqual({ kind: "too_large" });
  });

  it("refuses a GIF with a 1×1 screen and a 20,000 × 20,000 frame as too_large", async () => {
    expect(await fetchPath("/gif-huge-frame")).toEqual({ kind: "too_large" });
  });

  it("refuses a PNG declaring 100,000 × 100,000 pixels as too_large", async () => {
    expect(await fetchPath("/huge-pixels")).toEqual({ kind: "too_large" });
  });

  it("reports a 503 as an http_error", async () => {
    expect(await fetchPath("/unavailable")).toEqual({ kind: "http_error", status: 503 });
  });
});

describe("addresses that must never be requested", () => {
  it.each([
    ["to a loopback IP", "/r-loopback"],
    ["to a name that resolves to loopback", "/r-name"],
    ["to a link-local IP", "/r-link-local"],
  ])("refuses a redirect %s, never reaching it", async (_, path) => {
    expect(await fetchPath(path)).toEqual({ kind: "refused", reason: "address" });
    expect(targetHits).toBe(0);
  });

  it.each([
    ["a loopback", () => `http://127.0.0.1:${targetPort}/x.png`],
    ["a link-local", () => "http://169.254.169.254/latest/meta-data/"],
  ])("refuses %s image URL under the default address rule, without a request", async (_, url) => {
    const f = createImageFetcher({ version: VERSION });
    open.push(f);
    expect(await f.fetch(url())).toEqual({ kind: "refused", reason: "address" });
    expect(targetHits).toBe(0);
  });

  it("refuses a loopback image URL without a request", async () => {
    expect(await fetcher().fetch(`http://127.0.0.1:${targetPort}/`)).toEqual({
      kind: "refused",
      reason: "address",
    });
    expect(targetHits).toBe(0);
  });
});
