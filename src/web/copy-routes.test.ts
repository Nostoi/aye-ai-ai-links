import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { addSecondUser, oauthWorld } from "../auth/oauth-test-kit.js";
import { png } from "../core/image-test-kit.js";
import { getLinkWithText, saveLink } from "../core/links.js";
import { copyLimits, finishedMarkdown, imageRef } from "../core/saved-copy.js";
import { createDeps } from "../deps.js";
import { FakeEmbedder } from "../search/embedder.js";
import { DIMS } from "../search/model.js";
import { copyScripts } from "./copy-page.js";
import { pageScripts } from "./page.js";

const COPY_IMAGE = png(90, 70, Buffer.from("A's saved copy picture"));
const NONCE = "0123456789abcdef0123456789abcdef";
const LIMITS = copyLimits(1_000_000);

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A world on a temp folder whose owner has a link with a copy: image 1 stored, image 2 pending. */
async function world() {
  const dir = mkdtempSync(join(tmpdir(), "aye-copy-routes-"));
  dirs.push(dir);
  const w = await oauthWorld({ savedCopyDir: dir });
  const deps = createDeps(w.links, new FakeEmbedder(DIMS));
  const save = async (owner: string, url: string) =>
    (await saveLink(deps, owner, { url, savedBy: "seed", title: "Quokka" })).link.id;
  const id = await save("owner", "https://a.example/copy");
  const urls = ["https://img.example/1.png", "https://img.example/2.png"];
  const markdown = `![one](${imageRef(1, NONCE)}) ![two](${imageRef(2, NONCE)})`;
  const draft = { markdown, imageUrls: urls, nonce: NONCE };
  expect(await w.savedCopies.saveCopy("owner", id, draft, LIMITS, new Date())).toBe("saved");
  const stored = await w.savedCopies.saveCopyImage(
    "owner",
    id,
    1,
    urls[0] as string,
    { contentType: "image/png", bytes: COPY_IMAGE },
    LIMITS,
  );
  expect(stored).not.toBe(false);
  const owner = w.agent();
  await owner.signIn();
  return { w, id, owner, save };
}

describe("the copy image route", () => {
  it("serves the owner's copy picture uncached, even with a ?v= query", async () => {
    const { id, owner } = await world();
    for (const query of ["", "?v=anything"]) {
      const res = await owner.send(`/links/${id}/copy/images/1${query}`);
      expect(res.status).toBe(200);
      expect(res.bytes.equals(COPY_IMAGE)).toBe(true);
      expect(Object.fromEntries(res.headers)).toMatchObject({
        "content-type": "image/png",
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; sandbox",
        "cross-origin-resource-policy": "same-origin",
        "content-disposition": "inline",
        "cache-control": "no-store",
      });
    }
  });

  it("answers 503 uncached when the picture cannot be read", async () => {
    const { w, id, owner } = await world();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(w.savedCopies, "copyImage").mockRejectedValue(new Error("EIO"));
    const res = await owner.send(`/links/${id}/copy/images/1`);
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.bytes.includes(COPY_IMAGE)).toBe(false);
  });

  it("gives every missing picture the same 404 as /images/999, without A's bytes", async () => {
    const { w, id, owner, save } = await world();
    const none = await save("owner", "https://a.example/none");
    expect(await w.savedCopies.recordNoCopy("owner", none, "none")).toBe(true);
    const browser = await addSecondUser(w);
    const missing = await owner.send("/images/999");
    expect(missing.status).toBe(404);
    const sent = [
      await browser.send(`/links/${id}/copy/images/1`),
      await owner.send("/links/99999/copy/images/1"),
      await owner.send(`/links/${id}/copy/images/2`),
      await owner.send(`/links/${id}/copy/images/31`),
      await owner.send(`/links/${none}/copy/images/1`),
    ];
    for (const res of sent) {
      expect(res.status).toBe(404);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.bytes.equals(missing.bytes)).toBe(true);
      expect(res.bytes.includes(COPY_IMAGE)).toBe(false);
    }
  });

  it("sends a browser without a session to /login", async () => {
    const { w, id } = await world();
    const res = await w.agent().send(`/links/${id}/copy/images/1`);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login");
    expect(res.bytes.includes(COPY_IMAGE)).toBe(false);
  });

  it("refuses a request for another host", async () => {
    const { id, owner } = await world();
    const res = await owner.send(`/links/${id}/copy/images/1`, {
      headers: { host: "evil.example" },
    });
    expect(res.status).toBe(403);
    expect(res.bytes.includes(COPY_IMAGE)).toBe(false);
  });
});

const NEUTRAL = "A reading copy kept by this app. The page itself may have changed since.";

const sha = (text: string) => createHash("sha256").update(text).digest("base64");

/** The directives of an answer's CSP, each as its list of values. */
const directives = (res: { headers: Headers }) =>
  new Map(
    (res.headers.get("content-security-policy") ?? "")
      .split("; ")
      .map((d) => d.split(" ") as [string, ...string[]])
      .map(([name, ...values]) => [name, values.sort()] as const),
  );

/** The content of each `<script>` the answer's HTML holds. */
const scriptsOf = (res: { bytes: Buffer }) =>
  [...parseHTML(res.bytes.toString("utf8")).document.querySelectorAll("script")].map(
    (s) => s.textContent ?? "",
  );

/**
 * The CSP the answer must carry: today's directives, the style hash of the answer's own `<style>`,
 * `connect-src 'self'`, and a `script-src` of the hashes of `scripts` and no others.
 */
function expectCopyHeaders(res: { headers: Headers; bytes: Buffer }, scripts: string[]) {
  const doc = parseHTML(res.bytes.toString("utf8")).document;
  const style = doc.querySelector("style")?.textContent ?? "";
  expect(directives(res)).toEqual(
    new Map([
      ["default-src", ["'none'"]],
      ["img-src", ["'self'", "data:"]],
      ["style-src", [`'sha256-${sha(style)}'`]],
      ["script-src", [...new Set(scripts.map((s) => `'sha256-${sha(s)}'`))].sort()],
      ["connect-src", ["'self'"]],
      ["base-uri", ["'none'"]],
      ["form-action", ["'none'"]],
      ["frame-ancestors", ["'none'"]],
    ]),
  );
  expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  expect(res.headers.get("cache-control")).toBe("no-store");
}

describe("the copy page", () => {
  it("shows the owner's copy with its picture, under a full CSP and without script or style attributes", async () => {
    const { id, owner } = await world();
    const res = await owner.send(`/links/${id}/copy`);
    const html = res.bytes.toString("utf8");
    expect(res.status).toBe(200);
    expect(html).toContain("<h1>Quokka</h1>");
    expect(html).toContain(
      '<a href="https://a.example/copy" target="_blank" rel="noopener noreferrer">a.example</a>',
    );
    expect(html).toMatch(/Saved copy from [A-Z][a-z]+ \d+/);
    expect(html).toContain(NEUTRAL);
    expect(html).toContain(`src="/links/${id}/copy/images/1"`);
    expect(html).toContain("two");
    expect(html).not.toContain(`/links/${id}/copy/images/2`);
    expect(html).not.toMatch(/[0-9a-f]{32}/);
    const doc = parseHTML(html).document;
    expect(doc.querySelectorAll("[style]").length).toBe(0);
    expect(doc.querySelector("main.copy article.copy-article")).not.toBeNull();
    expectCopyHeaders(res, scriptsOf(res));
  });

  it("shows a finished copy's picture, and alt text for the one that was not stored", async () => {
    const { w, id, owner } = await world();
    const ended = await w.savedCopies.endCopyImage(
      "owner",
      id,
      2,
      "https://img.example/2.png",
      "none",
    );
    expect(ended).toBe(true);
    expect(await w.savedCopies.finishCopy("owner", id, finishedMarkdown, new Date())).toBe(true);
    const res = await owner.send(`/links/${id}/copy`);
    const html = res.bytes.toString("utf8");
    expect(res.status).toBe(200);
    expect(html).toContain(`src="/links/${id}/copy/images/1"`);
    expect(html).not.toContain("images/2");
    expect(html).not.toContain("images/01.png");
    expect(html).toContain("two");
  });

  it("shows a link saved around blocks (#220) as the card, then one link", async () => {
    const { w, owner, save } = await world();
    const id = await save("owner", "https://a.example/cards");
    const card = "https://cards.example/skill";
    const markdown = `[\n\n### Skill\n\nAbout it.\n\n](${card})`;
    const draft = { markdown, imageUrls: [], nonce: NONCE };
    expect(await w.savedCopies.saveCopy("owner", id, draft, LIMITS, new Date())).toBe("saved");
    const res = await owner.send(`/links/${id}/copy`);
    const html = res.bytes.toString("utf8");
    expect(res.status).toBe(200);
    expect(html).toContain("<h3>Skill</h3>");
    expect(html.match(new RegExp(`<a href="${card}"`, "g"))).toHaveLength(1);
    expect(html).not.toContain("](");
    expect(html).not.toContain("<p>[</p>");
  });

  it("gives every copy that is not the owner's the same 404, with the copy headers", async () => {
    const { w, id, owner, save } = await world();
    const none = await save("owner", "https://a.example/none");
    expect(await w.savedCopies.recordNoCopy("owner", none, "none")).toBe(true);
    const browser = await addSecondUser(w);
    const sent = [
      await browser.send(`/links/${id}/copy`),
      await owner.send("/links/99999/copy"),
      await owner.send(`/links/${"9".repeat(21)}/copy`),
      await owner.send(`/links/${none}/copy`),
    ];
    const first = sent[0];
    for (const res of sent) {
      expect(res.status).toBe(404);
      expect(res.bytes.equals(first?.bytes ?? Buffer.alloc(0))).toBe(true);
      expect(res.bytes.toString("utf8")).not.toContain("Quokka");
      expectCopyHeaders(res, copyScripts);
    }
  });

  it("says the files are missing when copy.md is gone", async () => {
    const { id, owner } = await world();
    unlinkSync(join(dirs[0] as string, id, "copy.md"));
    const res = await owner.send(`/links/${id}/copy`);
    expect(res.status).toBe(200);
    expect(res.bytes.toString("utf8")).toContain("This saved copy's files are missing.");
    expect(parseHTML(res.bytes.toString("utf8")).document.querySelector("article")).toBeNull();
    expectCopyHeaders(res, scriptsOf(res));
  });

  it("answers 503 when the copy cannot be read", async () => {
    const { w, id, owner } = await world();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(w.savedCopies, "readCopy").mockRejectedValue(new Error("EIO"));
    const res = await owner.send(`/links/${id}/copy`);
    expect(res.status).toBe(503);
    expect(res.bytes.toString("utf8")).toContain("couldn't be read just now");
    expect(parseHTML(res.bytes.toString("utf8")).document.querySelector("article")).toBeNull();
    expectCopyHeaders(res, scriptsOf(res));
  });

  it.skipIf(process.getuid?.() === 0)("still reads a copy while saving is paused", async () => {
    const { w, id, owner } = await world();
    const root = dirs[0] as string;
    chmodSync(root, 0o555);
    try {
      expect(await w.savedCopies.checkFolder()).toMatchObject({ state: "unwritable" });
      const res = await owner.send(`/links/${id}/copy`);
      expect(res.status).toBe(200);
      expect(
        parseHTML(res.bytes.toString("utf8")).document.querySelector("article"),
      ).not.toBeNull();
    } finally {
      chmodSync(root, 0o755);
    }
  });

  it("sends a browser without a session to /login", async () => {
    const { w, id } = await world();
    const res = await w.agent().send(`/links/${id}/copy`);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login");
    expect(res.bytes.toString("utf8")).not.toContain("Quokka");
  });

  it("refuses a request for another host", async () => {
    const { id, owner } = await world();
    const res = await owner.send(`/links/${id}/copy`, { headers: { host: "evil.example" } });
    expect(res.status).toBe(403);
    expect(res.bytes.toString("utf8")).not.toContain("Quokka");
  });
});

describe("the copy page's scripts and CSP", () => {
  it("lists exactly the hash of each script on the page in script-src, on every answer", async () => {
    const { w, id, owner } = await world();
    const ok = await owner.send(`/links/${id}/copy`);
    const rendered = scriptsOf(ok);
    expect(rendered.length).toBeGreaterThan(0);
    expectCopyHeaders(ok, rendered);
    const csp = ok.headers.get("content-security-policy");
    const missing = await owner.send("/links/99999/copy");
    expect(missing.status).toBe(404);
    expect(missing.headers.get("content-security-policy")).toBe(csp);
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(w.savedCopies, "readCopy").mockRejectedValue(new Error("EIO"));
    const unreadable = await owner.send(`/links/${id}/copy`);
    expect(unreadable.status).toBe(503);
    expect(unreadable.headers.get("content-security-policy")).toBe(csp);
  });

  it("runs only the app's own scripts: the page's menu script and the copy page's own", async () => {
    const { w, id, owner, save } = await world();
    const hostile = await save("owner", "https://a.example/hostile");
    const markdown =
      "<script>alert(1)</script>\n\n[click](javascript:alert(2))\n\n<img src=x onerror=alert(3)>";
    const draft = { markdown, imageUrls: [], nonce: NONCE };
    expect(await w.savedCopies.saveCopy("owner", hostile, draft, LIMITS, new Date())).toBe("saved");
    expect(copyScripts).toEqual(expect.arrayContaining(pageScripts({ menu: true })));
    for (const which of [id, hostile]) {
      const res = await owner.send(`/links/${which}/copy`);
      expect(res.status).toBe(200);
      expect([...scriptsOf(res)].sort()).toEqual([...copyScripts].sort());
      const doc = parseHTML(res.bytes.toString("utf8")).document;
      expect(doc.querySelectorAll("[href^=javascript], [onerror], img[src=x]")).toHaveLength(0);
    }
  });
});

const post = (id: string, origin = true) => ({ method: "POST", json: { id }, origin });
const rowOf = (w: Awaited<ReturnType<typeof world>>["w"], id: string, owner = "owner") =>
  w.links
    .prepare("SELECT status FROM saved_copies WHERE owner_id = ? AND link_id = ?")
    .get(owner, Number(id)) as { status: string } | undefined;
const MISSING_COPY = {
  code: "not_found",
  message: "That saved copy is not there any more. Reload the page.",
};
const TOO_LATE = {
  code: "not_found",
  message: "It's too late to undo: the saved copy was removed for good.",
};

describe("POST /links/copy/remove and /links/copy/restore", () => {
  it("removes the copy at once, hides it everywhere, and restores it within the window", async () => {
    const { w, id, owner } = await world();
    const deps = { ...createDeps(w.links, new FakeEmbedder(DIMS)), savedCopies: w.savedCopies };
    const before = (await owner.send(`/links/${id}/copy`)).bytes.toString("utf8");
    const removed = await owner.send("/links/copy/remove", post(id));
    expect(removed.status).toBe(204);
    expect(removed.headers.get("cache-control")).toBe("no-store");
    expect((await owner.send(`/links/${id}/copy`)).status).toBe(404);
    expect((await owner.send(`/links/${id}/copy/images/1`)).status).toBe(404);
    expect((await w.savedCopies.copyInfo("owner", [id])).size).toBe(0);
    expect((await getLinkWithText(deps, "owner", id, "t")).savedCopy).toBeNull();

    expect((await owner.send("/links/copy/restore", post(id))).status).toBe(204);
    const page = await owner.send(`/links/${id}/copy`);
    expect(page.status).toBe(200);
    expect(page.bytes.toString("utf8")).toBe(before);
    const image = await owner.send(`/links/${id}/copy/images/1`);
    expect(image.status).toBe(200);
    expect(image.bytes.equals(COPY_IMAGE)).toBe(true);

    const again = await owner.send("/links/copy/restore", post(id));
    expect(again.status).toBe(404);
    expect(again.body).toEqual(TOO_LATE);
    expect(rowOf(w, id)?.status).toBe("ok");
  });

  it("answers the copy wording to a remove of a copy that is not there", async () => {
    const { owner, id } = await world();
    await owner.send("/links/copy/remove", post(id));
    const res = await owner.send("/links/copy/remove", post(id));
    expect(res.status).toBe(404);
    expect(res.body).toEqual(MISSING_COPY);
  });

  it("refuses B's remove of A's copy and leaves it ok, on disk and on the page", async () => {
    const { w, id, owner } = await world();
    const browser = await addSecondUser(w);
    const res = await browser.send("/links/copy/remove", post(id));
    expect(res.status).toBe(404);
    expect(res.body).toEqual(MISSING_COPY);
    expect(rowOf(w, id)?.status).toBe("ok");
    expect(existsSync(join(dirs[0] as string, id, "copy.md"))).toBe(true);
    expect((await owner.send(`/links/${id}/copy`)).status).toBe(200);
  });

  it("refuses B's restore of A's removed copy and leaves it removed", async () => {
    const { w, id, owner } = await world();
    const browser = await addSecondUser(w);
    expect((await owner.send("/links/copy/remove", post(id))).status).toBe(204);
    const res = await browser.send("/links/copy/restore", post(id));
    expect(res.status).toBe(404);
    expect(res.body).toEqual(TOO_LATE);
    expect(rowOf(w, id)?.status).toBe("removed");
    expect((await owner.send(`/links/${id}/copy`)).status).toBe(404);
  });

  it("refuses a request without the site's Origin and changes nothing", async () => {
    const { w, id, owner } = await world();
    for (const path of ["/links/copy/remove", "/links/copy/restore"]) {
      expect((await owner.send(path, post(id, false))).status).toBe(403);
    }
    expect(rowOf(w, id)?.status).toBe("ok");
    await owner.send("/links/copy/remove", post(id));
    expect((await owner.send("/links/copy/restore", post(id, false))).status).toBe(403);
    expect(rowOf(w, id)?.status).toBe("removed");
  });

  it.skipIf(process.getuid?.() === 0)("still removes while saving is paused", async () => {
    const { w, id, owner } = await world();
    const root = dirs[0] as string;
    chmodSync(root, 0o555);
    try {
      expect(await w.savedCopies.checkFolder()).toMatchObject({ state: "unwritable" });
      expect((await owner.send("/links/copy/remove", post(id))).status).toBe(204);
      expect(rowOf(w, id)?.status).toBe("removed");
    } finally {
      chmodSync(root, 0o755);
    }
  });
});
