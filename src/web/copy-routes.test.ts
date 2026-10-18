import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseHTML } from "linkedom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { addSecondUser, oauthWorld } from "../auth/oauth-test-kit.js";
import { png } from "../core/image-test-kit.js";
import { saveLink } from "../core/links.js";
import { copyLimits, finishedMarkdown, imageRef } from "../core/saved-copy.js";
import { createDeps } from "../deps.js";
import { FakeEmbedder } from "../search/embedder.js";
import { DIMS } from "../search/model.js";

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

const CSP =
  "default-src 'none'; img-src 'self' data:; style-src 'sha256-HASH'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const NEUTRAL = "A reading copy kept by this app. The page itself may have changed since.";

/** The CSP the answer must carry: the hash is that of the answer's own `<style>`. */
function expectCopyHeaders(res: { headers: Headers; bytes: Buffer }) {
  const doc = parseHTML(res.bytes.toString("utf8")).document;
  const style = doc.querySelector("style")?.textContent ?? "";
  const hash = createHash("sha256").update(style).digest("base64");
  expect(res.headers.get("content-security-policy")).toBe(CSP.replace("HASH", hash));
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
    expect(html).not.toContain("data-open");
    expect(html).toMatch(/Saved copy from [A-Z][a-z]+ \d+/);
    expect(html).toContain(NEUTRAL);
    expect(html).toContain(`src="/links/${id}/copy/images/1"`);
    expect(html).toContain("two");
    expect(html).not.toContain(`/links/${id}/copy/images/2`);
    expect(html).not.toMatch(/[0-9a-f]{32}/);
    const doc = parseHTML(html).document;
    expect(doc.querySelectorAll("script").length).toBe(0);
    expect(doc.querySelectorAll("[style]").length).toBe(0);
    expect(doc.querySelector("main.copy article.copy-article")).not.toBeNull();
    expectCopyHeaders(res);
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
      expectCopyHeaders(res);
    }
  });

  it("says the files are missing when copy.md is gone", async () => {
    const { id, owner } = await world();
    unlinkSync(join(dirs[0] as string, id, "copy.md"));
    const res = await owner.send(`/links/${id}/copy`);
    expect(res.status).toBe(200);
    expect(res.bytes.toString("utf8")).toContain("This saved copy's files are missing.");
    expect(parseHTML(res.bytes.toString("utf8")).document.querySelector("article")).toBeNull();
    expectCopyHeaders(res);
  });

  it("answers 503 when the copy cannot be read", async () => {
    const { w, id, owner } = await world();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(w.savedCopies, "readCopy").mockRejectedValue(new Error("EIO"));
    const res = await owner.send(`/links/${id}/copy`);
    expect(res.status).toBe(503);
    expect(res.bytes.toString("utf8")).toContain("couldn't be read just now");
    expect(parseHTML(res.bytes.toString("utf8")).document.querySelector("article")).toBeNull();
    expectCopyHeaders(res);
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
