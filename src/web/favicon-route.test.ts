import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { addSecondUser, oauthWorld, SECOND_USER } from "../auth/oauth-test-kit.js";
import { png } from "../core/image-test-kit.js";
import { saveLink } from "../core/links.js";
import { createDeps } from "../deps.js";
import { FakeEmbedder } from "../search/embedder.js";
import { DIMS } from "../search/model.js";
import { rewriteFavicon, SqliteFaviconStore } from "../store/sqlite-favicons.js";
import { SqliteImageStore } from "../store/sqlite-image-store.js";

const FAVICON = png(32, 32, Buffer.from("a favicon's own bytes"));
const PICTURE = png(640, 480, Buffer.from("the link's one picture"));

/** Saves a link for `owner` whose page named a favicon; stores `bytes` as it when given. */
async function linkWithFavicon(db: Database.Database, owner: string, url: string, bytes?: Buffer) {
  const { link } = await saveLink(createDeps(db, new FakeEmbedder(DIMS)), owner, {
    url,
    savedBy: "seed",
    title: "Quokka habitat",
  });
  rewriteFavicon(db, owner, Number(link.id), [`${url}/favicon.png`]);
  if (bytes) {
    const stored = await new SqliteFaviconStore(db).writeFavicon(
      owner,
      link.id,
      1,
      { contentType: "image/png", bytes },
      new Date(),
    );
    expect(stored).toBe(true);
  }
  return link.id;
}

async function world() {
  const w = await oauthWorld();
  const owner = w.agent();
  await owner.signIn();
  return { w, owner };
}

const versionOf = async (db: Database.Database, id: string) =>
  (await new SqliteFaviconStore(db).faviconVersions("owner", [id])).get(id) as string;

describe("the favicon route (#272)", () => {
  it("★ serves the link's favicon, not its picture, with the stored-image headers and caching", async () => {
    // [Serving the link's one picture, or a favicon without the image route's safety headers.]
    const { w, owner } = await world();
    const id = await linkWithFavicon(w.links, "owner", "https://a.example/one", FAVICON);
    w.links
      .prepare(
        `UPDATE snapshots SET fetch_status = 'ok', image_url = 'https://a.example/p.png',
           image_status = 'pending' WHERE link_id = ?`,
      )
      .run(Number(id));
    const picture = { contentType: "image/png" as const, bytes: PICTURE };
    const images = new SqliteImageStore(w.links);
    const p = "https://a.example/p.png";
    expect(await images.writeImage("owner", id, p, "preview", picture, new Date())).toBe(true);

    const res = await owner.send(`/images/${id}/favicon?v=${await versionOf(w.links, id)}`);
    expect(res.status).toBe(200);
    expect(res.bytes.equals(FAVICON)).toBe(true);
    expect(Object.fromEntries(res.headers)).toMatchObject({
      "content-type": "image/png",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
      "cross-origin-resource-policy": "same-origin",
      "content-disposition": "inline",
      "cache-control": "private, max-age=31536000, immutable",
    });
    expect((await owner.send(`/images/${id}`)).bytes.equals(PICTURE)).toBe(true);
  });

  it.each([
    ["no version", ""],
    ["another version", "?v=0000000000000000"],
  ])("serves it uncached when the URL has %s", async (_, query) => {
    const { w, owner } = await world();
    const id = await linkWithFavicon(w.links, "owner", "https://a.example/one", FAVICON);
    const res = await owner.send(`/images/${id}/favicon${query}`);
    expect(res.status).toBe(200);
    expect(res.bytes.equals(FAVICON)).toBe(true);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("answers another owner's, a pending, a deleted and a missing link's favicon with the same uncached 404", async () => {
    const { w, owner } = await world();
    const mine = await linkWithFavicon(w.links, "owner", "https://a.example/one", FAVICON);
    const deleted = await linkWithFavicon(w.links, "owner", "https://a.example/gone", FAVICON);
    const waiting = await linkWithFavicon(w.links, "owner", "https://a.example/wait");
    const deps = createDeps(w.links, new FakeEmbedder(DIMS));
    expect(await deps.store.markDeleted("owner", deleted, new Date())).toBe(true);
    const browser = await addSecondUser(w);
    await linkWithFavicon(w.links, SECOND_USER.id, "https://b.example/theirs", FAVICON);
    const sent = [
      await browser.send(`/images/${mine}/favicon`),
      await owner.send(`/images/${deleted}/favicon`),
      await owner.send(`/images/${waiting}/favicon`),
      await owner.send("/images/99999/favicon"),
    ];
    for (const res of sent) {
      expect(res.status).toBe(404);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.bytes.equals(sent[0]?.bytes ?? Buffer.alloc(1))).toBe(true);
      expect(res.bytes.includes(FAVICON)).toBe(false);
    }
  });

  it("sends a browser without a session to /login", async () => {
    const w = await oauthWorld();
    const id = await linkWithFavicon(w.links, "owner", "https://a.example/one", FAVICON);
    const res = await w.agent().send(`/images/${id}/favicon`);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login");
    expect(res.bytes.includes(FAVICON)).toBe(false);
  });
});
