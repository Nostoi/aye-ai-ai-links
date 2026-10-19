import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { addSecondUser, oauthWorld } from "../auth/oauth-test-kit.js";
import { png } from "../core/image-test-kit.js";
import { getLink, saveLink } from "../core/links.js";
import { copyLimits, imageRef } from "../core/saved-copy.js";
import { keepHandy } from "../core/tools.js";
import { createDeps } from "../deps.js";
import { FakeEmbedder } from "../search/embedder.js";
import { DIMS } from "../search/model.js";
import { SqliteImageStore } from "../store/sqlite-image-store.js";

const TITLE = "Quokka habitat";
const URL_A = "https://a.example/quokka";
const PREVIEW = png(64, 48);
const COPY_IMAGE = png(90, 70, Buffer.from("A's saved copy picture"));
const NONCE = "0123456789abcdef0123456789abcdef";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * A world on a temp copy folder where the owner has one link, tagged Kitchen and kept handy (so
 * Home shows it), with a stored preview picture and a saved copy holding picture 1.
 */
async function world() {
  const dir = mkdtempSync(join(tmpdir(), "aye-delete-routes-"));
  dirs.push(dir);
  const w = await oauthWorld({ savedCopyDir: dir });
  const deps = createDeps(w.links, new FakeEmbedder(DIMS));
  const { link } = await saveLink(deps, "owner", {
    url: URL_A,
    savedBy: "seed",
    title: TITLE,
    tags: [{ name: "Kitchen", source: "stated" }],
  });
  const id = link.id;
  await keepHandy(deps, "owner", id, "stated");
  const imageUrl = `${URL_A}.png`;
  w.links
    .prepare(
      `UPDATE snapshots SET fetch_status = 'ok', next_fetch_at = NULL, image_url = ?,
         image_status = 'pending' WHERE link_id = ?`,
    )
    .run(imageUrl, Number(id));
  await new SqliteImageStore(w.links).writeImage(
    "owner",
    id,
    imageUrl,
    "preview",
    { contentType: "image/png", bytes: PREVIEW },
    new Date(),
  );
  const draft = {
    markdown: `![one](${imageRef(1, NONCE)})`,
    imageUrls: ["https://img.example/1.png"],
    nonce: NONCE,
  };
  const limits = copyLimits(1_000_000);
  expect(await w.savedCopies.saveCopy("owner", id, draft, limits, new Date())).toBe("saved");
  const stored = await w.savedCopies.saveCopyImage(
    "owner",
    id,
    1,
    "https://img.example/1.png",
    { contentType: "image/png", bytes: COPY_IMAGE },
    limits,
  );
  expect(stored).not.toBe(false);
  const owner = w.agent();
  await owner.signIn();
  return { w, deps, id, owner };
}

const post = (id: string, origin = true) => ({ method: "POST", json: { id }, origin });
const rowOf = (w: Awaited<ReturnType<typeof world>>["w"], id: string) =>
  w.links
    .prepare("SELECT deleted_at FROM links WHERE owner_id = ? AND id = ?")
    .get("owner", Number(id)) as { deleted_at: number | null } | undefined;
const TOO_LATE = {
  code: "not_found",
  message: "It's too late to undo: the link was deleted for good.",
};
const NOT_THERE = {
  code: "not_found",
  message: "That link is not there any more. Reload the page.",
};
const PAGES = ["/all", "/search?q=", "/spaces?tag=kitchen", "/"];
const BYTES = (id: string) => [`/images/${id}`, `/links/${id}/copy`, `/links/${id}/copy/images/1`];

describe("POST /links/delete and /links/restore", () => {
  it("deletes at once, hides the card everywhere, and restores it within the window", async () => {
    const { w, deps, id, owner } = await world();
    const before = await getLink(deps, "owner", id);
    for (const path of PAGES) {
      expect(String((await owner.send(path)).body), `${path} before`).toContain(TITLE);
    }

    const deleted = await owner.send("/links/delete", post(id));
    expect(deleted.status).toBe(204);
    expect(deleted.headers.get("cache-control")).toBe("no-store");
    expect(rowOf(w, id)?.deleted_at).toEqual(expect.any(Number));
    for (const path of PAGES) {
      expect(String((await owner.send(path)).body), `${path} after`).not.toContain(TITLE);
    }

    const restored = await owner.send("/links/restore", post(id));
    expect(restored.status).toBe(204);
    expect(restored.headers.get("cache-control")).toBe("no-store");
    expect(String((await owner.send("/all")).body)).toContain(TITLE);
    expect(await getLink(deps, "owner", id)).toEqual(before);

    const again = await owner.send("/links/restore", post(id));
    expect(again.status).toBe(404);
    expect(again.headers.get("cache-control")).toBe("no-store");
    expect(again.body).toEqual(TOO_LATE);
    expect(rowOf(w, id)?.deleted_at).toBeNull();
  });

  it("answers 404 with the reload message to a delete of a link that is not there", async () => {
    const { id, owner } = await world();
    expect((await owner.send("/links/delete", post(id))).status).toBe(204);
    for (const target of [id, "99999"]) {
      const res = await owner.send("/links/delete", post(target));
      expect(res.status).toBe(404);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.body).toEqual(NOT_THERE);
    }
  });

  it("refuses B's delete of A's link and leaves it live", async () => {
    const { w, id, owner } = await world();
    const browser = await addSecondUser(w);
    const res = await browser.send("/links/delete", post(id));
    expect(res.status).toBe(404);
    expect(res.body).toEqual(NOT_THERE);
    expect(rowOf(w, id)?.deleted_at).toBeNull();
    expect(String((await owner.send("/all")).body)).toContain(TITLE);
  });

  it("refuses B's restore of A's deleted link and leaves it hidden", async () => {
    const { w, id, owner } = await world();
    const browser = await addSecondUser(w);
    expect((await owner.send("/links/delete", post(id))).status).toBe(204);
    const hiddenAt = rowOf(w, id)?.deleted_at;
    const res = await browser.send("/links/restore", post(id));
    expect(res.status).toBe(404);
    expect(res.body).toEqual(TOO_LATE);
    expect(rowOf(w, id)?.deleted_at).toBe(hiddenAt);
    expect(String((await owner.send("/all")).body)).not.toContain(TITLE);
  });

  it("refuses a request without the site's Origin and changes nothing", async () => {
    const { w, id, owner } = await world();
    for (const path of ["/links/delete", "/links/restore"]) {
      expect((await owner.send(path, post(id, false))).status, path).toBe(403);
    }
    expect(rowOf(w, id)?.deleted_at).toBeNull();
    expect((await owner.send("/links/delete", post(id))).status).toBe(204);
    const hiddenAt = rowOf(w, id)?.deleted_at;
    expect((await owner.send("/links/restore", post(id, false))).status).toBe(403);
    expect(rowOf(w, id)?.deleted_at).toBe(hiddenAt);
  });

  it("byte routes answer 404 for a deleted link", async () => {
    const { id, owner } = await world();
    for (const path of BYTES(id)) {
      expect((await owner.send(path)).status, `${path} before`).toBe(200);
    }
    expect((await owner.send("/links/delete", post(id))).status).toBe(204);
    for (const path of BYTES(id)) {
      const res = await owner.send(path);
      expect(res.status, path).toBe(404);
      expect(res.bytes.includes(PREVIEW), path).toBe(false);
      expect(res.bytes.includes(COPY_IMAGE), path).toBe(false);
    }
  });

  it("a save of the same address during the window makes a new link and the old restore is too late", async () => {
    const { deps, id, owner } = await world();
    expect((await owner.send("/links/delete", post(id))).status).toBe(204);
    const saved = await owner.send("/save", {
      method: "POST",
      json: { url: URL_A, title: "Saved again", why: null },
    });
    expect(saved.status).toBe(200);
    const fresh = saved.body as { id: string; created: boolean };
    expect(fresh.created).toBe(true);
    expect(Number(fresh.id)).toBeGreaterThan(Number(id));
    const res = await owner.send("/links/restore", post(id));
    expect(res.status).toBe(404);
    expect(res.body).toEqual(TOO_LATE);
    expect((await getLink(deps, "owner", fresh.id)).title).toBe("Saved again");
  });
});
