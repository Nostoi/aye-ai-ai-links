import { createHash } from "node:crypto";
import { type Agent, oauthWorld, type World } from "../auth/oauth-test-kit.js";
import { png } from "../core/image-test-kit.js";
import { saveLink } from "../core/links.js";
import { createDeps } from "../deps.js";
import { FakeEmbedder } from "../search/embedder.js";
import { DIMS } from "../search/model.js";
import { SqliteImageStore } from "../store/sqlite-image-store.js";

/** Helpers for the edit routes' tests: a signed-in owner with an edited link, and the two requests. */
export const A = "owner";
export const URL = "https://a.example/quokkas";
export const PAGE = png(64, 48, Buffer.from("the page's own picture"));
export const MINE = png(80, 60, Buffer.from("the owner's screenshot"));
export const linkDeps = (world: World) => createDeps(world.links, new FakeEmbedder(DIMS));
export const v = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex").slice(0, 16);

/** A's titled link whose page title and picture were fetched, and A signed in. */
export async function edited() {
  const world = await oauthWorld();
  const { link } = await saveLink(linkDeps(world), A, {
    url: URL,
    savedBy: "seed",
    title: "Quokka habitat",
  });
  world.links
    .prepare(
      `UPDATE snapshots SET fetch_status = 'ok', next_fetch_at = NULL, title = 'Quokkas: a field guide',
           image_url = 'https://a.example/q.png', image_status = 'pending' WHERE link_id = ?`,
    )
    .run(Number(link.id));
  const page = { contentType: "image/png" as const, bytes: PAGE };
  await new SqliteImageStore(world.links).writeImage(
    A,
    link.id,
    "https://a.example/q.png",
    "preview",
    page,
    new Date(),
  );
  const browser = world.agent();
  await browser.signIn();
  return { world, browser, id: link.id };
}

export const form = (fields: Record<string, string | Blob>) => {
  const f = new FormData();
  for (const [name, value] of Object.entries(fields)) f.append(name, value);
  return f;
};
export const file = (bytes: Buffer, type = "image/png") =>
  new Blob([new Uint8Array(bytes)], { type });
export const edit = (browser: Agent, fields: Record<string, string | Blob>, extra = {}) =>
  browser.send("/links/edit", { method: "POST", multipart: form(fields), ...extra });
export const undo = (browser: Agent, json: unknown) =>
  browser.send("/links/edit/undo", { method: "POST", json });
/** A's links, pictures and edit records: what B's request must leave alone. */
export const ownedRows = (world: World, owner: string) =>
  Object.fromEntries(
    ["links", "owner_images", "link_edits", "link_images", "link_tags", "tags"].map((t) => [
      t,
      world.links.prepare(`SELECT * FROM ${t} WHERE owner_id = ? ORDER BY rowid`).all(owner),
    ]),
  );
/** What the edit routes answer for a card. */
export type Answer = {
  title: string | null;
  shown: string;
  url: string;
  initials: string;
  version: string | null;
  fit: "cover" | "contain" | null;
  picture: { own: boolean; pageVersion: string | null; pageFit: "cover" | "contain" | null };
  tags: { key: string; name: string; source: string }[];
  space: { color: string } | null;
  lineSpace: { name: string } | null;
  editId?: string | null;
};
