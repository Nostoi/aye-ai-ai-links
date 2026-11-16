import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { allRows, oauthWorld, type World } from "../auth/oauth-test-kit.js";
import { saveLink } from "../core/links.js";
import { issueOpenCodes, newOpenCode } from "../core/open-codes.js";
import { createDeps } from "../deps.js";
import { FakeEmbedder } from "../search/embedder.js";
import { DIMS } from "../search/model.js";
import { OPEN_LIMIT, openApp } from "./open-routes.js";

const A = "owner";
const URL_A = "https://ex.com/batteries";

/** A world with A's link and its code for the agent "Claude"; `lines` is the request log. */
async function opening(url = URL_A) {
  const lines: string[] = [];
  const world = await oauthWorld({ log: (line) => lines.push(line) });
  const deps = createDeps(world.links, new FakeEmbedder(DIMS));
  const { link } = await saveLink(deps, A, { url, savedBy: "Claude" });
  const code = (await issueOpenCodes(deps, A, [link], "Claude")).get(link.id) as string;
  expect(code).toEqual(expect.any(String));
  return { world, deps, link, code, lines, visitor: world.agent() };
}

const opened = (world: World) =>
  world.links.prepare("SELECT link_id AS link, kind FROM link_events ORDER BY rowid").all();

const post = (origin: string | false = "https://links.example") => ({
  method: "POST",
  ...(origin === false ? { origin: false } : { headers: { origin } }),
});

describe("GET /o/:code (#133)", () => {
  it("answers a page that forwards to the link, with no cache, referrer or indexing, and writes nothing", async () => {
    const { world, code, visitor } = await opening();
    const before = allRows(world);

    const sent = await visitor.send(`/o/${code}`);

    expect(sent.status).toBe(200);
    expect(sent.headers.get("content-type")).toMatch(/text\/html/);
    expect(String(sent.body)).toContain(`href="${URL_A}"`);
    expect(String(sent.body)).toContain("Continue to ex.com");
    expect(sent.headers.get("cache-control")).toBe("no-store");
    expect(sent.headers.get("referrer-policy")).toBe("no-referrer");
    expect(sent.headers.get("x-robots-tag")).toBe("noindex");
    expect(allRows(world)).toEqual(before);
  });

  it("puts a hostile address only in an escaped attribute, and runs only hashed scripts", async () => {
    const hostile = `https://x.example/a?q=</script><svg onload=alert(1)>&r="x'`;
    const { code, visitor } = await opening(hostile);

    const sent = await visitor.send(`/o/${code}`);
    const html = String(sent.body);

    expect(sent.status).toBe(200);
    // The app's logo is an inline <svg>; the address's must not become one.
    expect(html).not.toContain("<svg onload");
    expect(html).not.toContain("</script><svg");
    expect(html).toContain("&lt;/script&gt;&lt;svg onload=alert(1)&gt;&amp;r=&quot;x&#39;");
    const csp = sent.headers.get("content-security-policy") ?? "";
    expect(csp).toMatch(/default-src 'none'/);
    expect(csp).toMatch(/connect-src 'self'/);
    expect(csp).toMatch(/base-uri 'none'/);
    expect(csp).toMatch(/form-action 'none'/);
    expect(csp).toMatch(/frame-ancestors 'none'/);
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1] ?? "");
    expect(scripts.length).toBeGreaterThan(0);
    for (const script of scripts) {
      const hash = createHash("sha256").update(script).digest("base64");
      expect(csp).toContain(`'sha256-${hash}'`);
    }
    // The address reaches no script: each script is the same for every link.
    expect(scripts.join("\n")).not.toContain("x.example");
  });
});

describe("POST /o/:code (#133)", () => {
  it("records one opening of the code's link, with no session", async () => {
    const { world, deps, link, code, visitor } = await opening();

    const sent = await visitor.send(`/o/${code}`, post());

    expect(sent.status).toBe(204);
    expect(opened(world)).toEqual([{ link: Number(link.id), kind: "opened" }]);
    expect((await deps.store.get(A, link.id))?.lastOpenedAt).toEqual(expect.any(Date));
  });

  it("refuses a request from another site, an opaque origin or no Origin, and records nothing", async () => {
    const { world, code, visitor } = await opening();
    const before = allRows(world);

    const foreign = await visitor.send(`/o/${code}`, post("https://evil.example"));
    // A sandboxed frame or a data: page sends "null"; the page's own script sends its origin.
    const opaque = await visitor.send(`/o/${code}`, post("null"));
    const bare = await visitor.send(`/o/${code}`, post(false));

    expect([foreign.status, opaque.status, bare.status]).toEqual([403, 403, 403]);
    expect(allRows(world)).toEqual(before);
  });

  it("gives an unknown code and a deleted link's code the same 404, on GET and POST, and changes nothing", async () => {
    const { world, link, code, visitor } = await opening();
    world.links.prepare("UPDATE links SET deleted_at = 1 WHERE id = ?").run(Number(link.id));
    const before = allRows(world);
    const unknown = newOpenCode();

    const pages = [await visitor.send(`/o/${unknown}`), await visitor.send(`/o/${code}`)];
    const posts = [
      await visitor.send(`/o/${unknown}`, post()),
      await visitor.send(`/o/${code}`, post()),
    ];

    expect(pages.map((p) => p.status)).toEqual([404, 404]);
    expect(pages[0]?.bytes.equals(pages[1]?.bytes ?? Buffer.alloc(0))).toBe(true);
    expect(posts.map((p) => p.status)).toEqual([404, 404]);
    expect(posts[0]?.body).toEqual(posts[1]?.body);
    expect(allRows(world)).toEqual(before);
  });

  it("limits openings per code, leaving every other code free", async () => {
    const { world, deps, link, code, visitor } = await opening();
    const { link: other } = await saveLink(deps, A, { url: "https://ex.com/tiles", savedBy: "t" });
    const otherCode = (await issueOpenCodes(deps, A, [other], "Claude")).get(other.id) as string;

    const statuses: number[] = [];
    for (let i = 0; i <= OPEN_LIMIT.limit; i++) {
      statuses.push((await visitor.send(`/o/${code}`, post())).status);
    }
    const free = await visitor.send(`/o/${otherCode}`, post());

    expect(statuses.slice(0, OPEN_LIMIT.limit).every((s) => s === 204)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
    expect(free.status).toBe(204);
    const counts = opened(world).reduce<Record<number, number>>((n, e) => {
      const id = (e as { link: number }).link;
      n[id] = (n[id] ?? 0) + 1;
      return n;
    }, {});
    expect(counts).toEqual({ [Number(link.id)]: OPEN_LIMIT.limit, [Number(other.id)]: 1 });
  });
});

describe("the open routes' limiter", () => {
  it("is asked only about known codes, keyed by the code, so unknown codes add no keys", async () => {
    const { deps, code } = await opening();
    const keys: string[] = [];
    const app = openApp({
      deps,
      limiter: (key) => {
        keys.push(key);
        return { allowed: true };
      },
    });
    const send = (c: string) =>
      app.fetch(new Request(`https://links.example/o/${c}`, { method: "POST" }));

    for (let i = 0; i < 20; i++) expect((await send(newOpenCode())).status).toBe(404);
    expect((await send("not-a-code")).status).toBe(404);
    expect(keys).toEqual([]);

    expect((await send(code)).status).toBe(204);
    expect(keys).toEqual([code]);
  });
});

describe("the export (#130) and open codes", () => {
  it("leaves the codes out, as it leaves out keys", async () => {
    const { code, world } = await opening();
    const owner = world.agent();
    await owner.signIn();

    const exported = await owner.send("/export.json");

    expect(exported.status).toBe(200);
    expect(exported.bytes.toString("utf8")).toContain(URL_A);
    expect(exported.bytes.toString("utf8")).not.toContain(code);
  });
});

describe("the request log of /o/:code", () => {
  it("never holds a code, known or unknown, on a page, an opening or a 404", async () => {
    const { code, visitor, lines } = await opening();
    const unknown = newOpenCode();

    await visitor.send(`/o/${code}`);
    await visitor.send(`/o/${code}`, post());
    await visitor.send(`/o/${unknown}`);
    await visitor.send(`/o/${unknown}`, post());

    const logged = lines.filter((l) => l.includes(" /o/"));
    expect(logged).toHaveLength(4);
    for (const line of logged) {
      expect(line).not.toContain(code);
      expect(line).not.toContain(unknown);
    }
  });
});
