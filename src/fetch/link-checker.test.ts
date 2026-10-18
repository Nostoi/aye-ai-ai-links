import type { LookupAddress } from "node:dns";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { LinkChecker } from "../core/fetch.js";
import { isPublicAddress } from "./address-policy.js";
import type { Resolve } from "./guarded-lookup.js";
import { createLinkChecker } from "./link-checker.js";

/*
 * The layout of image-fetcher.test.ts. No test touches the network.
 *
 * - `target` listens on 127.0.0.1 and must never be reached: its hit counter is asserted to be 0.
 * - `site` listens on ::1, which the test policy treats as public. A fake resolver maps
 *   site.test to it; any other name it doesn't know fails as ENOTFOUND.
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

let target: http.Server;
let targetPort = 0;
let targetHits = 0;
let site: http.Server;
let sitePort = 0;
const VERSION = "v2099.01.02";
let lastMethod: string | undefined;
let lastUserAgent: string | undefined;

function handle(req: http.IncomingMessage, res: http.ServerResponse) {
  lastMethod = req.method;
  lastUserAgent = req.headers["user-agent"];
  const [, kind = ""] = (req.url ?? "/").split("/");
  const redirect = (status: number, location: string) => {
    res.writeHead(status, { location });
    res.end();
  };
  switch (kind) {
    case "ok":
      res.writeHead(200, { "content-type": "text/html" });
      return res.end("<p>here</p>");
    case "empty":
      res.writeHead(204);
      return res.end();
    case "endless":
      // Headers and a first chunk, then the body never ends.
      res.writeHead(200, { "content-type": "text/html" });
      res.write("<p>still going");
      return;
    case "hang":
      // Never answers.
      return;
    case "gone":
      res.writeHead(410);
      return res.end();
    case "r-ok":
      return redirect(301, "/ok");
    case "r-missing":
      return redirect(302, "/missing");
    case "r-nowhere":
      return redirect(302, `http://nowhere.test:${sitePort}/`);
    case "r-loopback":
      return redirect(302, `http://127.0.0.1:${targetPort}/`);
    case "r-name":
      return redirect(302, `http://evil.test:${targetPort}/`);
    default: {
      // /hop-N redirects N times, then lands on /ok.
      const hops = /^hop-(\d+)$/.exec(kind);
      if (hops) return redirect(302, Number(hops[1]) === 1 ? "/ok" : `/hop-${Number(hops[1]) - 1}`);
      res.writeHead(404);
      return res.end();
    }
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
    res.writeHead(200);
    res.end("reached");
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

const open: LinkChecker[] = [];
function checker(): LinkChecker {
  const c = createLinkChecker({ version: VERSION, resolve, isAllowed: allowSite });
  open.push(c);
  return c;
}
afterEach(async () => {
  await Promise.all(open.splice(0).map((c) => c.close()));
});

const siteUrl = (path: string) => `http://site.test:${sitePort}${path}`;
const check = (path: string) => checker().check(siteUrl(path));

describe("a page that answers", () => {
  it("is ok with its final URL, asked for with GET and the check's own User-Agent", async () => {
    expect(await check("/ok")).toEqual({ kind: "ok", finalUrl: siteUrl("/ok") });
    expect(lastMethod).toBe("GET");
    expect(lastUserAgent).toBe(
      `aye-ai-ai-links/${VERSION} (personal link library; checks that pages its owner saved still exist)`,
    );
  });

  it("is ok for a 204 with no body", async () => {
    expect(await check("/empty")).toEqual({ kind: "ok", finalUrl: siteUrl("/empty") });
  });

  it("is ok after a redirect, reporting where it ended", async () => {
    expect(await check("/r-ok")).toEqual({ kind: "ok", finalUrl: siteUrl("/ok") });
  });

  it("is ok well within the deadline for a 200 whose body never ends: the body is not read", async () => {
    const started = performance.now();
    expect(await check("/endless")).toEqual({ kind: "ok", finalUrl: siteUrl("/endless") });
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});

describe("a page that is gone", () => {
  it("reports a 404 and a 410 as http_error with the status", async () => {
    expect(await check("/missing")).toEqual({ kind: "http_error", status: 404 });
    expect(await check("/gone")).toEqual({ kind: "http_error", status: 410 });
  });

  it("reports a redirect chain that ends in 404 as that 404", async () => {
    expect(await check("/r-missing")).toEqual({ kind: "http_error", status: 404 });
  });

  it("reports a name that doesn't resolve, first or after a redirect, as ENOTFOUND (A1)", async () => {
    expect(await checker().check(`http://nowhere.test:${sitePort}/`)).toEqual({
      kind: "network_error",
      code: "ENOTFOUND",
    });
    expect(await check("/r-nowhere")).toEqual({ kind: "network_error", code: "ENOTFOUND" });
  });
});

describe("a check that cannot finish", () => {
  it("follows five redirects, and refuses a sixth as too_many_redirects", async () => {
    expect(await check("/hop-5")).toEqual({ kind: "ok", finalUrl: siteUrl("/ok") });
    expect(await check("/hop-6")).toEqual({ kind: "refused", reason: "too_many_redirects" });
  });

  it("returns aborted promptly when the caller's signal aborts a server that never answers", async () => {
    const caller = new AbortController();
    const started = Date.now();
    const pending = checker().check(siteUrl("/hang"), caller.signal);
    setTimeout(() => caller.abort(), 50);
    expect(await pending).toEqual({ kind: "aborted" });
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe("addresses that must never be requested", () => {
  it.each([
    ["to a loopback IP", "/r-loopback"],
    ["to a name that resolves to loopback", "/r-name"],
  ])("refuses a redirect %s, never reaching it", async (_, path) => {
    expect(await check(path)).toEqual({ kind: "refused", reason: "address" });
    expect(targetHits).toBe(0);
  });

  it("refuses a loopback URL under the default address rule, without a request", async () => {
    const c = createLinkChecker({ version: VERSION });
    open.push(c);
    expect(await c.check(`http://127.0.0.1:${targetPort}/`)).toEqual({
      kind: "refused",
      reason: "address",
    });
    expect(targetHits).toBe(0);
  });

  it("refuses a URL with credentials, without a request", async () => {
    expect(await checker().check(`http://user:pw@site.test:${sitePort}/ok`)).toEqual({
      kind: "refused",
      reason: "credentials",
    });
  });
});
