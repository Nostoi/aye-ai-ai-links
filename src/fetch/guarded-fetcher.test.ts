import type { LookupAddress } from "node:dns";
import http from "node:http";
import net, { type AddressInfo } from "node:net";
import zlib from "node:zlib";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FetchOutcome, PageFetcher } from "../core/fetch.js";
import { isPublicAddress } from "./address-policy.js";
import { createGuardedFetcher, type FetcherLimits } from "./guarded-fetcher.js";
import type { Resolve } from "./guarded-lookup.js";

/*
 * Test layout. No test touches the network.
 *
 * - `target` listens on 127.0.0.1 and must never be reached: its hit counter is asserted to be 0.
 * - `site` listens on ::1, which the test policy treats as an "allowed public" address. A fake
 *   resolver maps site.test to it, so a URL such as http://site.test:6000/ stands in for a public
 *   host on any port. The address policy is the only thing that tells ::1 from 127.0.0.1.
 */
const V4_LOOPBACK: LookupAddress = { address: "127.0.0.1", family: 4 };
const V6_LOOPBACK: LookupAddress = { address: "::1", family: 6 };

const names: Record<string, LookupAddress[]> = {
  "site.test": [V6_LOOPBACK],
  "evil.test": [V4_LOOPBACK],
  "mixed.test": [V6_LOOPBACK, V4_LOOPBACK],
  "mixed-rev.test": [V4_LOOPBACK, V6_LOOPBACK],
};

const resolve: Resolve = async (hostname) => {
  const found = names[hostname];
  if (!found) throw Object.assign(new Error(`no such host ${hostname}`), { code: "ENOTFOUND" });
  return found;
};

const allowSite = (ip: string) => ip === "::1" || isPublicAddress(ip);

// Ports that the Fetch standard blocks. Nothing binds them: a parallel test run may hold them.
const BLOCKED_PORTS = [6000, 10080];

let target: http.Server;
let targetPort = 0;
let targetHits = 0;

let site: http.Server;
let sitePort = 0;
let siteHits: string[] = [];
let lastRequestHeaders: http.IncomingHttpHeaders = {};

const BOMB_BYTES = 20_000_000;
const bomb = zlib.gzipSync(Buffer.alloc(BOMB_BYTES, 0x20));
const html = (title: string) => `<!doctype html><title>${title}</title><p>hello</p>`;

function redirect(res: http.ServerResponse, status: number, location?: string) {
  res.writeHead(status, location === undefined ? {} : { location });
  res.end();
}

function handle(req: http.IncomingMessage, res: http.ServerResponse) {
  const path = req.url ?? "/";
  siteHits.push(path);
  lastRequestHeaders = req.headers;
  const send = (
    type: string | null,
    body: string | Buffer,
    extra: http.OutgoingHttpHeaders = {},
  ) => {
    res.writeHead(200, type === null ? extra : { "content-type": type, ...extra });
    res.end(body);
  };
  const [, kind = "", arg = ""] = path.split("/");

  switch (kind) {
    case "ok":
      return send("text/html; charset=utf-8", html("ok"));
    case "xhtml":
      return send("application/xhtml+xml", html("xhtml"));
    case "pdf":
      return send("application/pdf", "%PDF-1.7");
    case "notype":
      return send(null, html("untyped"));
    case "status":
      res.writeHead(Number(arg), { "content-type": "text/html" });
      return res.end(html("status"));
    case "r":
      return redirect(res, Number(arg), "/ok");
    case "r-no-location":
      return redirect(res, 302);
    case "r-bad-location":
      return redirect(res, 302, "http://[bad");
    case "r-file":
      return redirect(res, 302, "file:///etc/passwd");
    case "r-credentials":
      return redirect(res, 302, `http://user:pw@site.test:${sitePort}/ok`);
    case "r-ip":
      return redirect(res, 302, `http://127.0.0.1:${targetPort}/`);
    case "r-name":
      return redirect(res, 301, `http://evil.test:${targetPort}/`);
    case "r-mapped":
      return redirect(res, 307, `http://[::ffff:127.0.0.1]:${targetPort}/`);
    case "r-port":
      return redirect(res, 302, `http://site.test:${arg}/ok`);
    case "loop":
      return redirect(res, 302, "/loop");
    case "chain":
      return Number(arg) > 0
        ? redirect(res, 302, `/chain/${Number(arg) - 1}`)
        : send("text/html", html("end"));
    case "gzip":
      return send("text/html", zlib.gzipSync(html("gzip")), { "content-encoding": "gzip" });
    case "deflate":
      return send("text/html", zlib.deflateSync(html("deflate")), {
        "content-encoding": "deflate",
      });
    case "br":
      return send("text/html", zlib.brotliCompressSync(html("br")), { "content-encoding": "br" });
    case "zstd":
      return send("text/html", html("zstd"), { "content-encoding": "zstd" });
    case "truncated":
      return send("text/html", zlib.gzipSync(html("cut")).subarray(0, 12), {
        "content-encoding": "gzip",
      });
    case "bomb":
      return send("text/html", bomb, { "content-encoding": "gzip" });
    case "big":
      return send("text/html", "a".repeat(Number(arg)));
    case "latin1":
      return send("text/html; charset=iso-8859-1", Buffer.from("<p>café</p>", "latin1"));
    case "slow":
      return void setTimeout(() => send("text/html", html("slow")), 300);
    case "hang":
      return; // never answers
    case "stall":
      res.writeHead(200, { "content-type": "text/html" });
      return void res.write("<p>start");
    default:
      res.writeHead(404, { "content-type": "text/html" });
      return res.end("not found");
  }
}

function listen(server: http.Server, host: string): Promise<number> {
  return new Promise((done, fail) => {
    server.once("error", (err) =>
      fail(new Error(`test server could not listen on [${host}]: ${err.message}`)),
    );
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
    res.writeHead(200, { "content-type": "text/html" });
    res.end("SECRET");
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
  siteHits = [];
});

const open: PageFetcher[] = [];
function fetcherWith(
  options: {
    isAllowed?: (ip: string) => boolean;
    resolve?: Resolve;
    limits?: Partial<FetcherLimits>;
  } = {},
): PageFetcher {
  const fetcher = createGuardedFetcher({ resolve, isAllowed: allowSite, ...options });
  open.push(fetcher);
  return fetcher;
}

afterEach(async () => {
  await Promise.all(open.splice(0).map((f) => f.close()));
});

const siteUrl = (path: string) => `http://site.test:${sitePort}${path}`;

async function ok(outcome: Promise<FetchOutcome>) {
  const result = await outcome;
  if (result.kind !== "ok") throw new Error(`expected ok, got ${JSON.stringify(result)}`);
  return result;
}

describe("a page on an allowed address", () => {
  it("is returned with its final URL and content type", async () => {
    const page = await ok(fetcherWith().fetch(siteUrl("/ok")));
    expect(page.finalUrl).toBe(siteUrl("/ok"));
    expect(page.contentType).toBe("text/html; charset=utf-8");
    expect(page.html).toBe(html("ok"));
  });

  it("accepts application/xhtml+xml", async () => {
    expect((await ok(fetcherWith().fetch(siteUrl("/xhtml")))).html).toBe(html("xhtml"));
  });

  it("identifies itself and offers the encodings it can decode", async () => {
    await ok(fetcherWith().fetch(siteUrl("/ok")));
    expect(lastRequestHeaders["user-agent"]).toMatch(/aye-ai-ai-links/);
    expect(lastRequestHeaders["accept-encoding"]).toBe("gzip, deflate, br");
  });

  /*
   * The fixed ports are not bound, so a parallel test run cannot collide with this one. Whatever
   * is or is not listening there, the fetcher must have tried to connect: an unused port ends as
   * ECONNREFUSED, a used one as a response. Only a policy refusal is ruled out.
   */
  const connectAttempted = (outcome: FetchOutcome) =>
    outcome.kind === "network_error"
      ? ["ECONNREFUSED", "UND_ERR_SOCKET", "ECONNRESET"].includes(outcome.code)
      : ["ok", "http_error", "not_html"].includes(outcome.kind);

  it.each(BLOCKED_PORTS)(
    "tries to connect to port %i, which the Fetch standard blocks (any port on a public address)",
    async (port) => {
      const outcome = await fetcherWith().fetch(`http://site.test:${port}/ok`);
      expect(outcome.kind).not.toBe("refused");
      expect(connectAttempted(outcome), JSON.stringify(outcome)).toBe(true);
    },
  );

  it.each(BLOCKED_PORTS)("follows a redirect to port %i and tries to connect", async (port) => {
    const outcome = await fetcherWith().fetch(siteUrl(`/r-port/${port}`));
    expect(siteHits).toEqual([`/r-port/${port}`]);
    expect(outcome.kind).not.toBe("refused");
    expect(connectAttempted(outcome), JSON.stringify(outcome)).toBe(true);
  });

  it.each([
    ["gzip", "/gzip"],
    ["deflate", "/deflate"],
    ["br", "/br"],
  ])("decodes Content-Encoding %s", async (name, path) => {
    expect((await ok(fetcherWith().fetch(siteUrl(path)))).html).toBe(html(name));
  });

  it("decodes the charset the server declared", async () => {
    expect((await ok(fetcherWith().fetch(siteUrl("/latin1")))).html).toBe("<p>café</p>");
  });
});

describe("URLs that must never be requested", () => {
  // PORT is the target server's port, known only once the servers are listening.
  const forbidden = [
    "http://127.0.0.1:PORT/",
    "http://localhost:PORT/",
    "http://[::1]:PORT/",
    "http://127.1:PORT/",
    "http://2130706433:PORT/",
    "http://0x7f.1:PORT/",
    "http://[::ffff:127.0.0.1]:PORT/",
    "http://evil.test:PORT/",
  ];

  it.each(forbidden)("refuses %s", async (template) => {
    expect(targetPort).toBeGreaterThan(0);
    const url = template.replace("PORT", String(targetPort));
    // The default policy, not the test one: nothing here may be allowed.
    const fetcher = createGuardedFetcher({
      resolve: (h) =>
        h === "localhost" ? Promise.resolve([V4_LOOPBACK, V6_LOOPBACK]) : resolve(h),
    });
    open.push(fetcher);
    expect(await fetcher.fetch(url)).toEqual({ kind: "refused", reason: "address" });
    expect(targetHits).toBe(0);
  });

  it.each([
    "http://100.100.100.100/",
    "http://169.254.169.254/latest/meta-data/",
    "http://10.0.0.1/",
    "http://192.168.1.1/",
    "http://172.16.0.1/",
    "http://[fd7a:115c:a1e0::53]/",
    "http://[fe80::1]/",
    "http://[::127.0.0.1]/",
    "http://0.0.0.0/",
  ])("refuses %s before any socket is opened", async (url) => {
    const connect = vi.spyOn(net.Socket.prototype, "connect").mockImplementation(() => {
      throw new Error("a socket was opened");
    });
    try {
      expect(await createGuardedFetcher().fetch(url)).toEqual({
        kind: "refused",
        reason: "address",
      });
      expect(connect).not.toHaveBeenCalled();
    } finally {
      connect.mockRestore();
    }
  });

  it.each([
    ["file:///etc/passwd", "scheme"],
    ["ftp://site.test/", "scheme"],
    ["javascript:alert(1)", "scheme"],
    ["data:text/html,hi", "scheme"],
    ["http://user:pw@site.test/", "credentials"],
    ["http://user@site.test/", "credentials"],
    ["not a url", "invalid_url"],
    ["", "invalid_url"],
  ])("refuses %j as %s", async (url, reason) => {
    expect(await fetcherWith().fetch(url)).toEqual({ kind: "refused", reason });
    expect(siteHits).toEqual([]);
  });
});

describe("redirects", () => {
  it.each([301, 302, 303, 307, 308])("follows a %i with a Location", async (status) => {
    const page = await ok(fetcherWith().fetch(siteUrl(`/r/${status}`)));
    expect(page.finalUrl).toBe(siteUrl("/ok"));
  });

  it("does not follow a 300, which is an error response here", async () => {
    expect(await fetcherWith().fetch(siteUrl("/r/300"))).toEqual({
      kind: "http_error",
      status: 300,
    });
    expect(siteHits).toEqual(["/r/300"]);
  });

  it.each([
    ["/r-ip", "to an IP address"],
    ["/r-name", "to a name that resolves to loopback"],
    ["/r-mapped", "to an IPv4-mapped IPv6 address"],
  ])("refuses a redirect %s without reaching the target", async (path) => {
    expect(await fetcherWith().fetch(siteUrl(path))).toEqual({
      kind: "refused",
      reason: "address",
    });
    expect(targetHits).toBe(0);
  });

  it("refuses a redirect to a non-http scheme", async () => {
    expect(await fetcherWith().fetch(siteUrl("/r-file"))).toEqual({
      kind: "refused",
      reason: "scheme",
    });
  });

  it("refuses a redirect that carries credentials", async () => {
    expect(await fetcherWith().fetch(siteUrl("/r-credentials"))).toEqual({
      kind: "refused",
      reason: "credentials",
    });
    expect(siteHits).toEqual(["/r-credentials"]);
  });

  it.each(["/r-no-location", "/r-bad-location"])("gives bad_redirect for %s", async (path) => {
    expect(await fetcherWith().fetch(siteUrl(path))).toEqual({
      kind: "refused",
      reason: "bad_redirect",
    });
  });

  it("follows five redirects and refuses the sixth", async () => {
    expect((await ok(fetcherWith().fetch(siteUrl("/chain/5")))).finalUrl).toBe(siteUrl("/chain/0"));
    siteHits = [];
    expect(await fetcherWith().fetch(siteUrl("/chain/6"))).toEqual({
      kind: "refused",
      reason: "too_many_redirects",
    });
    expect(siteHits).toHaveLength(6);
  });

  it("stops a redirect loop", async () => {
    expect(await fetcherWith().fetch(siteUrl("/loop"))).toEqual({
      kind: "refused",
      reason: "too_many_redirects",
    });
  });
});

describe("DNS answers", () => {
  it.each(["mixed.test", "mixed-rev.test"])(
    "refuses %s, which resolves to an allowed and a forbidden address",
    async (host) => {
      expect(await fetcherWith().fetch(`http://${host}:${sitePort}/ok`)).toEqual({
        kind: "refused",
        reason: "address",
      });
      expect(siteHits).toEqual([]);
      expect(targetHits).toBe(0);
    },
  );

  it("reports a name that does not resolve as a network error", async () => {
    expect(await fetcherWith().fetch(`http://nowhere.test:${sitePort}/`)).toEqual({
      kind: "network_error",
      code: "ENOTFOUND",
    });
  });
});

describe("what comes back", () => {
  it.each([
    ["/pdf", "application/pdf"],
    ["/notype", ""],
  ])("returns not_html for %s", async (path, contentType) => {
    expect(await fetcherWith().fetch(siteUrl(path))).toEqual({ kind: "not_html", contentType });
  });

  it("returns not_html for a Content-Encoding it cannot decode", async () => {
    expect(await fetcherWith().fetch(siteUrl("/zstd"))).toEqual({
      kind: "not_html",
      contentType: "text/html",
    });
  });

  it.each([404, 500])("returns http_error for %i", async (status) => {
    expect(await fetcherWith().fetch(siteUrl(`/status/${status}`))).toEqual({
      kind: "http_error",
      status,
    });
  });

  it("returns a network_error for a connection that is refused", async () => {
    const free = http.createServer();
    const port = await listen(free, "::1");
    await close(free);
    const outcome = await fetcherWith().fetch(`http://site.test:${port}/`);
    expect(outcome).toEqual({ kind: "network_error", code: "ECONNREFUSED" });
  });

  it("returns a network_error for a truncated compressed body", async () => {
    expect((await fetcherWith().fetch(siteUrl("/truncated"))).kind).toBe("network_error");
  });
});

describe("size limit", () => {
  it("counts decompressed bytes: a small gzip bomb is too_large", async () => {
    const maxBytes = 1_000_000;
    expect(bomb.length).toBeLessThan(maxBytes);
    expect(BOMB_BYTES).toBeGreaterThan(maxBytes);
    // Only the kind is compared: a failure must not print a 20 MB page.
    const outcome = await fetcherWith({ limits: { maxBytes } }).fetch(siteUrl("/bomb"));
    expect(outcome.kind).toBe("too_large");
  });

  it("allows a body of exactly maxBytes and refuses one byte more", async () => {
    const fetcher = fetcherWith({ limits: { maxBytes: 100 } });
    expect((await fetcher.fetch(siteUrl("/big/100"))).kind).toBe("ok");
    expect(await fetcher.fetch(siteUrl("/big/101"))).toEqual({ kind: "too_large" });
  });

  it("caps a page at 5 MiB when no limits are passed, as the server builds it", async () => {
    const fetcher = fetcherWith();
    const cap = 5 * 1024 * 1024;
    expect((await fetcher.fetch(siteUrl(`/big/${cap}`))).kind).toBe("ok");
    expect(await fetcher.fetch(siteUrl(`/big/${cap + 1}`))).toEqual({ kind: "too_large" });
  });
});

describe("deadline and cancellation", () => {
  const DEADLINE = 300;
  const SLACK = 1000;

  async function timed(outcome: Promise<FetchOutcome>) {
    const started = performance.now();
    const result = await outcome;
    return { result, elapsed: performance.now() - started };
  }

  it("settles at the deadline, well before the connect timeout, when the lookup never answers", async () => {
    const fetcher = fetcherWith({
      resolve: () => new Promise(() => {}),
      limits: { deadlineMs: DEADLINE },
    });
    const { result, elapsed } = await timed(fetcher.fetch(siteUrl("/ok")));
    expect(result).toEqual({ kind: "timeout" });
    expect(elapsed).toBeLessThan(DEADLINE + SLACK);
  });

  it.each(["/hang", "/stall"])("settles at the deadline when %s never finishes", async (path) => {
    const fetcher = fetcherWith({ limits: { deadlineMs: DEADLINE } });
    const { result, elapsed } = await timed(fetcher.fetch(siteUrl(path)));
    expect(result).toEqual({ kind: "timeout" });
    expect(elapsed).toBeLessThan(DEADLINE + SLACK);
  });

  it.each([
    ["the headers", "/hang"],
    ["the body", "/stall"],
  ])("reports aborted when the caller cancels during %s", async (_where, path) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const { result, elapsed } = await timed(fetcherWith().fetch(siteUrl(path), controller.signal));
    expect(result).toEqual({ kind: "aborted" });
    expect(elapsed).toBeLessThan(100 + SLACK);
  });

  it("reports aborted for a signal that is already cancelled, without a request", async () => {
    expect(await fetcherWith().fetch(siteUrl("/ok"), AbortSignal.abort())).toEqual({
      kind: "aborted",
    });
    expect(siteHits).toEqual([]);
  });

  it("reports aborted when the caller cancels during the lookup", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    const fetcher = fetcherWith({ resolve: () => new Promise(() => {}) });
    expect(await fetcher.fetch(siteUrl("/ok"), controller.signal)).toEqual({ kind: "aborted" });
  });

  it("cancelling one of two concurrent calls does not cancel the other", async () => {
    const fetcher = fetcherWith();
    const controller = new AbortController();
    const cancelled = fetcher.fetch(siteUrl("/slow"), controller.signal);
    const kept = fetcher.fetch(siteUrl("/slow"));
    setTimeout(() => controller.abort(), 50);
    expect(await cancelled).toEqual({ kind: "aborted" });
    expect((await kept).kind).toBe("ok");
  });
});

describe("close()", () => {
  it("stops a fetch in flight", async () => {
    const fetcher = fetcherWith();
    const pending = fetcher.fetch(siteUrl("/hang"));
    await new Promise((r) => setTimeout(r, 50));
    await fetcher.close();
    expect((await pending).kind).toBe("network_error");
  });

  it("makes later fetches fail as a network_error rather than throw", async () => {
    const fetcher = fetcherWith();
    await fetcher.close();
    expect((await fetcher.fetch(siteUrl("/ok"))).kind).toBe("network_error");
    expect(siteHits).toEqual([]);
  });
});
