import type Database from "better-sqlite3";
import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import { addSecondUser, oauthWorld, SECOND_USER, type World } from "../auth/oauth-test-kit.js";
import { png } from "../core/image-test-kit.js";
import { saveLink } from "../core/links.js";
import type { SnapshotRecord } from "../core/snapshot-store.js";
import { record } from "../core/snapshot-store-contract.js";
import { keepHandy } from "../core/tools.js";
import { createDeps } from "../deps.js";
import { FakeEmbedder } from "../search/embedder.js";
import { DIMS } from "../search/model.js";
import { SqliteImageStore } from "../store/sqlite-image-store.js";
import { SqliteStore } from "../store/sqlite-store.js";

const PNG = png(64, 48);

/** Saves a link for `owner` whose snapshot named `imageUrl`; stores `bytes` as its image when given. */
async function linkWithImage(
  db: Database.Database,
  owner: string,
  url: string,
  { imageUrl = `${url}.png`, bytes }: { imageUrl?: string; bytes?: Buffer } = {},
) {
  const { link } = await saveLink(createDeps(db, new FakeEmbedder(DIMS)), owner, {
    url,
    savedBy: "seed",
    title: "Quokka habitat",
  });
  db.prepare(
    `UPDATE snapshots SET fetch_status = 'ok', next_fetch_at = NULL, image_url = ?,
       image_status = 'pending' WHERE link_id = ?`,
  ).run(imageUrl, Number(link.id));
  if (bytes) {
    const images = new SqliteImageStore(db);
    await images.writeImage(
      owner,
      link.id,
      imageUrl,
      "preview",
      { contentType: "image/png", bytes },
      new Date(),
    );
  }
  return link.id;
}

async function world() {
  const w = await oauthWorld();
  const owner = w.agent();
  await owner.signIn();
  return { w, owner };
}

const versionOf = async (w: World, id: string) =>
  (await new SqliteImageStore(w.links).imageVersions("owner", [id])).get(id)?.version as string;

describe("the image route", () => {
  it("serves the owner's stored image with its sniffed type, safe headers and a year of private caching", async () => {
    const { w, owner } = await world();
    const id = await linkWithImage(w.links, "owner", "https://a.example/one", { bytes: PNG });
    const res = await owner.send(`/images/${id}?v=${await versionOf(w, id)}`);
    expect(res.status).toBe(200);
    expect(res.bytes.equals(PNG)).toBe(true);
    expect(Object.fromEntries(res.headers)).toMatchObject({
      "content-type": "image/png",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
      "cross-origin-resource-policy": "same-origin",
      "content-disposition": "inline",
      "cache-control": "private, max-age=31536000, immutable",
    });
  });

  it("?page=1 serves the fetched picture while the owner's shows; B gets the same 404 for A's either way", async () => {
    const { w, owner } = await world();
    const id = await linkWithImage(w.links, "owner", "https://a.example/one", { bytes: PNG });
    const mine = png(80, 60, Buffer.from("the owner's own"));
    const deps = createDeps(w.links, new FakeEmbedder(DIMS));
    const set = { set: { contentType: "image/png" as const, bytes: mine } };
    await deps.edits.applyEdit("owner", id, { picture: set }, new Date());
    expect((await owner.send(`/images/${id}`)).bytes.equals(mine)).toBe(true);
    expect((await owner.send(`/images/${id}?page=1`)).bytes.equals(PNG)).toBe(true);
    const browser = await addSecondUser(w);
    const missing = await browser.send("/images/99999?page=1");
    for (const path of [`/images/${id}`, `/images/${id}?page=1`]) {
      const res = await browser.send(path);
      expect(res.status).toBe(404);
      expect(res.bytes.equals(missing.bytes)).toBe(true);
      expect(res.bytes.includes(PNG) || res.bytes.includes(mine)).toBe(false);
    }
  });

  it.each([
    ["no version", ""],
    ["another version", "?v=0000000000000000"],
  ])("serves it uncached when the URL has %s", async (_, query) => {
    const { w, owner } = await world();
    const id = await linkWithImage(w.links, "owner", "https://a.example/one", { bytes: PNG });
    const res = await owner.send(`/images/${id}${query}`);
    expect(res.status).toBe(200);
    expect(res.bytes.equals(PNG)).toBe(true);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("answers another owner's image, a link with no image, a missing link and id 0 with the same uncached 404", async () => {
    const { w } = await world();
    const mine = await linkWithImage(w.links, "owner", "https://a.example/one", { bytes: PNG });
    const browser = await addSecondUser(w);
    const theirsNone = await linkWithImage(w.links, SECOND_USER.id, "https://b.example/none");
    const sent = [];
    for (const path of [`/images/${mine}`, `/images/${theirsNone}`, "/images/99999", "/images/0"]) {
      sent.push(await browser.send(path));
    }
    for (const res of sent) {
      expect(res.status).toBe(404);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.bytes.equals(sent[0]?.bytes ?? Buffer.alloc(1))).toBe(true);
      expect(res.bytes.includes(PNG)).toBe(false);
    }
  });

  it("sends a browser without a session to /login", async () => {
    const w = await oauthWorld();
    const id = await linkWithImage(w.links, "owner", "https://a.example/one", { bytes: PNG });
    const res = await w.agent().send(`/images/${id}`);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login");
    expect(res.bytes.includes(PNG)).toBe(false);
  });

  it("refuses a request for another host before any session or image is read", async () => {
    const { w, owner } = await world();
    const id = await linkWithImage(w.links, "owner", "https://a.example/one", { bytes: PNG });
    const res = await owner.send(`/images/${id}`, { headers: { host: "evil.example" } });
    expect(res.status).toBe(403);
    expect(res.bytes.includes(PNG)).toBe(false);
  });
});

describe("the search page's images", () => {
  it("shows a stored image from this site and the tile for a link whose image is only remote", async () => {
    const { w, owner } = await world();
    const stored = await linkWithImage(w.links, "owner", "https://a.example/one", { bytes: PNG });
    await linkWithImage(w.links, "owner", "https://a.example/two", {
      imageUrl: "https://cdn.example/two.png",
    });
    const html = String((await owner.send("/search?q=quokka")).body);
    expect(html).toContain(`src="/images/${stored}?v=${await versionOf(w, stored)}"`);
    expect(html.match(/<div class="tile initials-box" aria-hidden="true">/g)).toHaveLength(1);
    expect(html).not.toContain("cdn.example");
  });
});

describe("the Handy shelf's images", () => {
  it("fills a kept tool's and a suggestion's tile with their stored images, and a bare one with none", async () => {
    const { w, owner } = await world();
    const deps = createDeps(w.links, new FakeEmbedder(DIMS));
    const keptId = await linkWithImage(w.links, "owner", "https://a.example/kept", { bytes: PNG });
    const guessId = await linkWithImage(w.links, "owner", "https://a.example/guess", {
      bytes: PNG,
    });
    const bareId = await linkWithImage(w.links, "owner", "https://a.example/bare");
    await keepHandy(deps, "owner", keptId, "stated");
    await keepHandy(deps, "owner", guessId, "inferred");
    await keepHandy(deps, "owner", bareId, "stated");
    const html = String((await owner.send("/")).body);
    const shelf = parseHTML(html).document.getElementById("handy-shelf") as HTMLElement;
    const src = (id: string) =>
      shelf.querySelector(`[data-id="${id}"] img.handy-image`)?.getAttribute("src");
    expect(src(keptId)).toBe(`/images/${keptId}?v=${await versionOf(w, keptId)}`);
    expect(src(guessId)).toBe(`/images/${guessId}?v=${await versionOf(w, guessId)}`);
    expect(shelf.querySelector(`[data-id="${bareId}"] img`)).toBeNull();
    expect(shelf.querySelector(`[data-id="${bareId}"] .pic-initials`)).not.toBeNull();
  });
});

describe("a retired stored icon", () => {
  it("★ a stored icon retired by a named preview shows initials, and its bytes are gone", async () => {
    const { w, owner } = await world();
    const deps = createDeps(w.links, new FakeEmbedder(DIMS));
    const { link } = await saveLink(deps, "owner", {
      url: "https://a.example/pea",
      savedBy: "seed",
      title: "Photo Pea",
    });
    const store = new SqliteStore(w.links);
    const images = new SqliteImageStore(w.links);
    const recordNow = async (r: SnapshotRecord) => {
      const now = new Date();
      const lease = await store.leaseSnapshot(
        "owner",
        link.id,
        now,
        new Date(now.getTime() + 60_000),
      );
      if (!lease) throw new Error("expected a lease");
      expect(await store.recordSnapshot("owner", link.id, lease.claim, r)).toBe(true);
    };
    await recordNow(
      record({
        status: "retrying",
        nextFetchAt: new Date(0),
        imageUrl: null,
        iconUrls: ["https://a.example/i.png"],
      }),
    );
    await images.writeImage(
      "owner",
      link.id,
      "https://a.example/i.png",
      "icon",
      { contentType: "image/png", bytes: png(128, 128) },
      new Date(),
    );
    const before = String((await owner.send("/search?q=pea")).body);
    expect(before).toContain('class="tile icon-box"');
    await recordNow(record({ imageUrl: "https://a.example/p.png" }));
    for (const path of ["/search?q=pea", "/all"]) {
      const card = parseHTML(String((await owner.send(path)).body)).document.querySelector(
        `[data-id="${link.id}"]`,
      );
      expect(card?.querySelector(".initials-box .pic-initials")?.textContent).toBe("PP");
      expect(card?.querySelector("img")).toBeNull();
    }
    expect((await owner.send(`/images/${link.id}`)).status).toBe(404);
  });
});
