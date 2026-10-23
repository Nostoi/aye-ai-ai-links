import { setImmediate as nextTurn } from "node:timers/promises";
import { bookmarksHtml } from "./bookmarks-html.js";
import { createCopyReader, type ReadGate } from "./copy-reading.js";
import {
  buildManifest,
  copyFilePath,
  copyImagePath,
  copyWithFrontMatter,
  type ManifestCopy,
  type ManifestDeps,
  type ManifestLink,
  picturePath,
} from "./export-format.js";
import { ExportStopped, type ExportSummary, type StopFlag } from "./export-types.js";
import type { LinkImageReader, StoredImage } from "./image-store.js";
import { finishedMarkdown, IMAGE_EXT, type SavedCopyReader } from "./saved-copy.js";
import type { LinkStore } from "./store.js";
import type { Link, OwnerId } from "./types.js";
import { createZipWriter, type ZipSink } from "./zip.js";

/** AppDeps' names (R2), so a route or `createDeps` can pass its deps as they are. */
export type ExportDeps = ManifestDeps & {
  store: Pick<LinkStore, "listLinksAndTags" | "get">;
  images: Pick<LinkImageReader, "pictureInfo" | "image">;
  savedCopies: SavedCopyReader;
  readGate: ReadGate;
};

type Picture = NonNullable<ManifestLink["picture"]>;

const utf8 = (s: string) => Buffer.from(s, "utf8");

/**
 * Writes the owner's library to `sink` as a stored zip: each link's pictures and saved copy, then
 * `links.json` and `bookmarks.html` (docs/specs/2026-10-18-export-design.md, "Core").
 * - Point in time per link: a copy's files are read into memory and written only when the
 *   ledger still shows the same copy afterwards; otherwise the link's copy is `removed`.
 * - Stopping: the flag is checked before every store and file read, and again when a read
 *   queued at the gate gets its turn; once set, the build throws `ExportStopped`.
 * - Fairness: one gated read at a time, and a yield to the event loop between links.
 */
export async function writeExport(
  deps: ExportDeps,
  owner: OwnerId,
  sink: ZipSink,
  stop: StopFlag,
): Promise<ExportSummary> {
  const check = () => {
    if (stop.stopped) throw new ExportStopped();
  };
  const guarded = <T>(read: () => Promise<T>): Promise<T> =>
    stop.stopped ? Promise.reject(new ExportStopped()) : read();
  const s = deps.savedCopies; // a class instance: spreading it would drop its methods
  const copies: SavedCopyReader = {
    copyInfo: (o, ids) => s.copyInfo(o, ids),
    listCopies: (o) => s.listCopies(o),
    readCopy: (o, id) => guarded(() => s.readCopy(o, id)),
    copyImage: (o, id, n) => guarded(() => s.copyImage(o, id, n)),
  };
  // After a stop, a queued read rejects or reaches its deadline; neither is a read failure.
  const log = (message: string, error?: unknown) => {
    if (stop.stopped) return;
    if (error === undefined) console.error(message);
    else console.error(message, error);
  };
  const reader = createCopyReader({ store: deps.store, copies, gate: deps.readGate, log });

  check();
  const exportedAt = deps.now();
  check();
  const { links, tags: catalog } = await deps.store.listLinksAndTags(owner);
  check();
  const tools = await deps.tools.listTools(owner);
  check();
  const checks = await deps.checks.listChecks(owner);
  check();
  const notes = await deps.profile.listNotes(owner);
  check();
  const focus = await deps.profile.listFocus(owner);
  check();
  const info = await deps.images.pictureInfo(
    owner,
    links.map((l) => l.id),
  );
  check();
  const ledger = await s.listCopies(owner);

  const zip = createZipWriter(sink, exportedAt);
  let files = 0;
  const add = async (name: string, data: Uint8Array) => {
    await zip.add(name, data);
    files++;
  };

  /** The link's own and page pictures, each read explicitly; a read that finds none writes no file. */
  async function pictures(link: Link, n: number): Promise<Picture> {
    const has = info.get(link.id);
    const picture: Picture = { own: null, page: null, pageRole: null };
    if (has?.own) {
      check();
      const own = await deps.images.image(owner, link.id, "own");
      if (own) {
        picture.own = picturePath(n, "own", own.contentType);
        await add(picture.own, own.bytes);
      }
    }
    if (has && has.pageVersion !== null) {
      check();
      const page = await deps.images.image(owner, link.id, "page");
      if (page) {
        // R1a: the role comes from this read, with these bytes, never from pictureInfo's pageFit.
        if (!page.role) throw new Error("a page picture was read without its role");
        picture.page = picturePath(n, "page", page.contentType);
        picture.pageRole = page.role;
        await add(picture.page, page.bytes);
      }
    }
    return picture;
  }

  /**
   * The link's `ok` copy, taken at one point in time; `ledgerMadeAt` dates any other outcome (R8).
   * An image that cannot be read is left out and the text kept: a finished copy.md is written
   * unchanged, and an unfinished one gets a lost picture, `![alt]()`, for it (spec, "copy.md with front matter").
   * The first unreadable image ends the copy's image reads; a gone one does not.
   */
  async function copy(link: Link, n: number, ledgerMadeAt: Date): Promise<ManifestCopy> {
    const without = (status: "removed" | "missing" | "unreadable"): ManifestCopy => ({
      status,
      madeAt: ledgerMadeAt.toISOString(),
      file: null,
      images: [],
    });
    const madeAt = async () => {
      check();
      return (await copies.copyInfo(owner, [link.id])).get(link.id)?.madeAt.getTime();
    };
    const before = await madeAt();
    if (before === undefined) return without("removed");
    check();
    const read = await reader.read(owner, link.id);
    check(); // a stop while queued at the gate reads as "unreadable": end here, not at the next check
    if (read === null) return without("removed");
    if (read === "missing" || read === "unreadable") return without(read);
    if (read.madeAt.getTime() !== before) return without("removed");
    const got: { nn: number; image: StoredImage }[] = [];
    const readImage = async (nn: number) => {
      check();
      const image = await reader.image(owner, link.id, nn);
      check();
      return image;
    };
    for (const nn of [...read.images.keys()].sort((a, b) => a - b)) {
      // A Remove then Undo during the read answers null for a copy that is whole again: read once more.
      const image = (await readImage(nn)) ?? (await readImage(nn));
      if (image === "unreadable") break;
      if (image !== null) got.push({ nn, image });
    }
    if ((await madeAt()) !== read.madeAt.getTime()) return without("removed");
    const images: string[] = [];
    for (const { nn, image } of got) {
      const path = copyImagePath(n, nn, image.contentType);
      await add(path, image.bytes);
      images.push(path);
    }
    const markdown =
      read.finished || read.nonce === null
        ? read.markdown
        : finishedMarkdown(
            read.markdown,
            read.nonce,
            got.map(({ nn, image }) => ({ n: nn, ext: IMAGE_EXT[image.contentType] })),
          );
    const file = copyFilePath(n);
    await add(file, utf8(copyWithFrontMatter(link, read.madeAt, markdown)));
    return { status: "ok", madeAt: read.madeAt.toISOString(), file, images };
  }

  const pictureOf = new Map<string, Picture>();
  const copyOf = new Map<string, ManifestCopy>();
  for (const [i, link] of links.entries()) {
    const n = i + 1;
    pictureOf.set(link.id, await pictures(link, n));
    const row = ledger.get(link.id);
    if (row?.status === "ok") copyOf.set(link.id, await copy(link, n, row.madeAt));
    else if (row)
      copyOf.set(link.id, {
        status: "removed",
        madeAt: row.madeAt.toISOString(),
        file: null,
        images: [],
      });
    await nextTurn();
  }
  check();
  const manifest = buildManifest({
    exportedAt,
    links,
    catalog,
    tools,
    checks,
    notes,
    focus,
    copies: copyOf,
    pictures: pictureOf,
  });
  await add("links.json", utf8(JSON.stringify(manifest)));
  await add("bookmarks.html", utf8(bookmarksHtml(links, catalog, exportedAt)));
  await zip.finish();
  return { exportedAt, links: links.length, files };
}
