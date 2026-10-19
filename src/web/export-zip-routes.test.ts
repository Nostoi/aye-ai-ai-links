import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TEST_BASE_URL } from "../auth/memory-auth.js";
import { type Agent, addSecondUser, oauthWorld, SECOND_USER } from "../auth/oauth-test-kit.js";
import { png } from "../core/image-test-kit.js";
import { saveLink } from "../core/links.js";
import { copyLimits, imageRef } from "../core/saved-copy.js";
import { validateZip } from "../core/zip-test-kit.js";
import { createDeps } from "../deps.js";
import { FakeEmbedder } from "../search/embedder.js";
import { DIMS } from "../search/model.js";
import { SqliteImageStore } from "../store/sqlite-image-store.js";

const A = "owner";
const B = SECOND_USER.id;
const NONCE = "0123456789abcdef0123456789abcdef";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const tempDir = (label: string) => {
  const dir = mkdtempSync(join(tmpdir(), `aye-export-zip-${label}-`));
  dirs.push(dir);
  return dir;
};

async function world() {
  const w = await oauthWorld({ savedCopyDir: tempDir("copies"), exportDir: tempDir("exports") });
  return { w, deps: createDeps(w.links, new FakeEmbedder(DIMS)) };
}
type W = Awaited<ReturnType<typeof world>>["w"];
type Deps = ReturnType<typeof createDeps>;

/** What each owner's library holds, every piece marked so it can be found in a zip's raw bytes. */
const marks = (mark: string, pictureTail = Buffer.from(`${mark} page picture bytes`)) => ({
  url: `https://${mark}.example/kept`,
  tag: `${mark} tag key`,
  copyText: `${mark} saved copy text`,
  picture: png(301, 101, pictureTail),
  copyPicture: png(302, 102, Buffer.from(`${mark} copy picture bytes`)),
});

/** One link with a tag, a stored page picture, and an ok saved copy holding one picture. */
async function seed(w: W, deps: Deps, owner: string, m: ReturnType<typeof marks>) {
  const { link } = await saveLink(deps, owner, {
    url: m.url,
    savedBy: "seed",
    title: `${m.tag} title`,
    tags: [{ name: m.tag, source: "stated" }],
  });
  const imageUrl = `${m.url}/picture.png`;
  w.links
    .prepare(
      `UPDATE snapshots SET fetch_status = 'ok', next_fetch_at = NULL, image_url = ?,
         image_status = 'pending' WHERE link_id = ?`,
    )
    .run(imageUrl, Number(link.id));
  const image = { contentType: "image/png" as const, bytes: m.picture };
  expect(
    await new SqliteImageStore(w.links).writeImage(
      owner,
      link.id,
      imageUrl,
      "preview",
      image,
      new Date(),
    ),
  ).toBe(true);
  const copyImageUrl = `${m.url}/copy.png`;
  const draft = {
    markdown: `${m.copyText}\n\n![pic](${imageRef(1, NONCE)})`,
    imageUrls: [copyImageUrl],
    nonce: NONCE,
  };
  const limits = copyLimits(100_000_000);
  expect(await w.savedCopies.saveCopy(owner, link.id, draft, limits, new Date())).toBe("saved");
  expect(
    await w.savedCopies.saveCopyImage(
      owner,
      link.id,
      1,
      copyImageUrl,
      { contentType: "image/png", bytes: m.copyPicture },
      limits,
    ),
  ).not.toBe(false);
}

const signedIn = async (w: W) => {
  const owner = w.agent();
  await owner.signIn();
  return owner;
};
const prepare = (agent: Agent) => agent.send("/export/prepare", { method: "POST" });

/** Holds the one read gate, so a build waits at its first saved-copy read until released. */
function holdGate(w: W) {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  void w.readGate.run(() => held, 60_000);
  return release;
}

const everyMark = (m: ReturnType<typeof marks>) => [
  m.url,
  m.tag,
  m.copyText,
  m.picture,
  m.copyPicture,
];

describe("POST /export/prepare and GET /export.zip", () => {
  it("signed out, prepare and download redirect to /login; a foreign Origin gets 403 on both", async () => {
    const { w } = await world();
    const stranger = w.agent();
    for (const sent of [await prepare(stranger), await stranger.send("/export.zip")]) {
      expect([sent.status, sent.headers.get("location")]).toEqual([302, "/login"]);
    }
    const owner = await signedIn(w);
    const evil = { origin: "https://evil.example" };
    expect((await owner.send("/export/prepare", { method: "POST", headers: evil })).status).toBe(
      403,
    );
    expect((await owner.send("/export.zip", { headers: evil })).status).toBe(403);
    expect((await owner.send("/export/prepare", { method: "POST", origin: false })).status).toBe(
      403,
    );
    expect(w.exports.view(A)).toEqual({ state: "idle" });
  });

  it("prepare answers 202, a second while preparing 409 already_preparing and no second build; the zip downloads with its headers", async () => {
    const { w, deps } = await world();
    await seed(w, deps, A, marks("quokka"));
    const owner = await signedIn(w);
    const release = holdGate(w);
    const first = await prepare(owner);
    expect([first.status, first.bytes.length, first.headers.get("cache-control")]).toEqual([
      202,
      0,
      "no-store",
    ]);
    const again = await prepare(owner);
    expect([again.status, again.body]).toEqual([409, { code: "already_preparing" }]);
    expect(again.headers.get("cache-control")).toBe("no-store");
    release();
    await w.exports.settled(A);
    const view = w.exports.view(A);
    if (view.state !== "ready") throw new Error(`the build ended ${view.state}`);
    const zip = await owner.send("/export.zip");
    expect(zip.status).toBe(200);
    expect(
      Object.fromEntries(
        ["cache-control", "x-content-type-options", "content-type", "content-disposition"].map(
          (h) => [h, zip.headers.get(h)],
        ),
      ),
    ).toEqual({
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="aye-links-${view.exportedAt.toISOString().slice(0, 10)}.zip"`,
    });
    expect(Number(zip.headers.get("content-length"))).toBe(zip.bytes.length);
    expect(zip.bytes.length).toBe(view.bytes);
    const path = join(tempDir("zip"), "a.zip");
    writeFileSync(path, zip.bytes);
    validateZip(path);
  });

  it("two owners: B's prepare runs while A's does, B's download never holds A's bytes, and A's file is unchanged by B's build", async () => {
    const { w, deps } = await world();
    const b = await addSecondUser(w);
    const [mA, mB] = [marks("quokka"), marks("zebra")];
    await seed(w, deps, A, mA);
    await seed(w, deps, B, mB);
    const a = await signedIn(w);
    const release = holdGate(w);
    expect((await prepare(a)).status).toBe(202);
    expect((await prepare(b)).status).toBe(202);
    expect([w.exports.view(A).state, w.exports.view(B).state]).toEqual(["preparing", "preparing"]);
    release();
    await Promise.all([w.exports.settled(A), w.exports.settled(B)]);
    const aZip = await a.send("/export.zip");
    const bZip = await b.send("/export.zip");
    expect([aZip.status, bZip.status]).toEqual([200, 200]);
    for (const m of everyMark(mB)) expect(bZip.bytes.includes(m)).toBe(true);
    for (const m of everyMark(mA)) expect(bZip.bytes.includes(m), String(m)).toBe(false);

    expect((await prepare(b)).status).toBe(202);
    await w.exports.settled(B);
    const aAfter = await a.send("/export.zip");
    expect(aAfter.bytes.equals(aZip.bytes)).toBe(true);
  });

  it("owner isolation in the zip: no B text, URL, tag key, picture bytes or copy text in A's files or manifest", async () => {
    const { w, deps } = await world();
    await addSecondUser(w);
    const [mA, mB] = [marks("quokka"), marks("zebra")];
    await seed(w, deps, A, mA);
    await seed(w, deps, B, mB);
    const a = await signedIn(w);
    expect((await prepare(a)).status).toBe(202);
    await w.exports.settled(A);
    const zip = await a.send("/export.zip");
    expect(zip.status).toBe(200);
    for (const m of everyMark(mA)) expect(zip.bytes.includes(m), String(m)).toBe(true);
    for (const m of everyMark(mB)) expect(zip.bytes.includes(m), String(m)).toBe(false);
    expect(zip.bytes.toString("latin1").toLowerCase()).not.toContain("zebra");
  });

  it("HEAD /export.zip answers GET's headers with no body and leaves no file open", async () => {
    const { w, deps } = await world();
    await seed(w, deps, A, marks("quokka", Buffer.alloc(1024 * 1024, 7)));
    const owner = await signedIn(w);
    expect((await prepare(owner)).status).toBe(202);
    await w.exports.settled(A);
    const get = await owner.send("/export.zip");
    expect(get.status).toBe(200);
    const fds = () => readdirSync("/dev/fd").length;
    const before = fds();
    for (let i = 0; i < 20; i++) {
      const head = await owner.send("/export.zip", { method: "HEAD" });
      expect([head.status, head.bytes.length]).toEqual([200, 0]);
      for (const h of ["content-length", "content-disposition", "content-type"]) {
        expect(head.headers.get(h), h).toBe(get.headers.get(h));
      }
    }
    await vi.waitFor(() => expect(fds()).toBe(before));
  });

  it("GET /export.zip with nothing prepared is 404 no-store", async () => {
    const { w } = await world();
    const sent = await (await signedIn(w)).send("/export.zip");
    expect([sent.status, sent.headers.get("cache-control")]).toEqual([404, "no-store"]);
  });

  it("a download started before a new build completes is byte-identical to the old file", async () => {
    const { w, deps } = await world();
    await seed(w, deps, A, marks("quokka", Buffer.alloc(200 * 1024, 7)));
    const owner = await signedIn(w);
    expect((await prepare(owner)).status).toBe(202);
    await w.exports.settled(A);
    const old = await owner.send("/export.zip");
    expect(old.bytes.length).toBeGreaterThan(64 * 1024);
    const cookie = [...owner.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    const res = await w.app.fetch(
      new Request(`${TEST_BASE_URL}/export.zip`, {
        headers: { host: new URL(TEST_BASE_URL).host, cookie },
      }),
    );
    expect(res.status).toBe(200);
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const chunks: Uint8Array[] = [];
    const first = await reader.read();
    if (first.done) throw new Error("no first chunk");
    chunks.push(first.value);
    expect(first.value.length).toBeLessThan(old.bytes.length);

    await saveLink(deps, A, { url: "https://quokka.example/added", savedBy: "seed" });
    expect((await prepare(owner)).status).toBe(202);
    await w.exports.settled(A);
    expect(w.exports.view(A).state).toBe("ready");
    const rebuilt = await owner.send("/export.zip");
    expect(rebuilt.bytes.equals(old.bytes)).toBe(false);

    for (let r = await reader.read(); !r.done; r = await reader.read()) chunks.push(r.value);
    expect(Buffer.concat(chunks).equals(old.bytes)).toBe(true);
  });

  it("/connections shows the build's state: Preparing… while running, Download when ready", async () => {
    const { w, deps } = await world();
    await seed(w, deps, A, marks("quokka"));
    const owner = await signedIn(w);
    const page = async () => String((await owner.send("/connections")).body);
    expect(await page()).toContain("Prepare export");
    const release = holdGate(w);
    expect((await prepare(owner)).status).toBe(202);
    const preparing = await page();
    expect(preparing).toContain("Preparing your export…");
    expect(preparing).not.toContain('href="/export.zip"');
    release();
    await w.exports.settled(A);
    const ready = await page();
    expect(ready).toContain('href="/export.zip"');
    expect(ready).not.toContain("Preparing your export…");
  });
});
