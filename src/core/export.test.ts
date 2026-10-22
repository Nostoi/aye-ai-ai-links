import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { bookmarksHtml } from "./bookmarks-html.js";
import { createCopyReader, createReadGate, type ReadGate } from "./copy-reading.js";
import { type ExportDeps, writeExport } from "./export.js";
import { copyWithFrontMatter, manifestSchema } from "./export-format.js";
import { ExportStopped, type StopFlag } from "./export-types.js";
import { FakeProfileStore } from "./fake-profile-store.js";
import { FakeSavedCopies } from "./fake-saved-copies.js";
import { FakeStore } from "./fake-store.js";
import type { ImageType } from "./fetch.js";
import type { ImageBytes, ImageRole, PictureInfo } from "./image-store.js";
import {
  copyLimits,
  finishedMarkdown,
  imageRef,
  type ReadCopy,
  type SavedCopyReader,
} from "./saved-copy.js";
import { A, at, B, newLink, record } from "./snapshot-store-contract.js";
import type { Link, NewLink, OwnerId } from "./types.js";
import { readZip, validateZip } from "./zip-test-kit.js";

const NOW = new Date("2026-10-19T08:00:00.250Z");
const MADE = at(50);
const NONCE = "0123456789abcdef0123456789abcdef";
const LIMITS = copyLimits(100 << 20);
const utf8 = (b: Uint8Array) => Buffer.from(b).toString("utf8");
/** Image bytes the fakes store as given; `tail` makes them distinct. */
const pic = (contentType: ImageType, tail: string): ImageBytes => ({
  contentType,
  bytes: new Uint8Array(Buffer.from(`${contentType}|${tail}|picture-bytes`)),
});
const has = (haystack: Uint8Array, needle: Uint8Array | string) =>
  Buffer.from(haystack).includes(typeof needle === "string" ? needle : Buffer.from(needle));

let dir: string;
let zips = 0;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "aye-export-test-"));
});
afterAll(() => rm(dir, { recursive: true, force: true }));
afterEach(() => {
  vi.restoreAllMocks();
});

function setup(readGate: ReadGate = createReadGate()) {
  const store = new FakeStore();
  const profile = new FakeProfileStore();
  const savedCopies = new FakeSavedCopies(store);
  const deps: ExportDeps = {
    store,
    tools: store,
    checks: store,
    profile,
    images: store,
    savedCopies,
    readGate,
    now: () => NOW,
  };
  const save = async (owner: OwnerId, n: number, over: Partial<NewLink> = {}) =>
    (await store.insertIfAbsent(owner, { ...newLink(n, at(n)), ...over })).link.id;
  const ownPicture = async (owner: OwnerId, id: string, image: ImageBytes) =>
    expect(await store.applyEdit(owner, id, { picture: { set: image } }, at(502))).not.toBeNull();
  /** A fetched picture, as the image pass stores one for this role. */
  const pagePicture = async (
    owner: OwnerId,
    id: string,
    image: ImageBytes,
    role: ImageRole = "preview",
  ) => {
    const url = `https://img.example/${id}`;
    const lease = await store.leaseSnapshot(owner, id, at(5000), at(6000));
    if (!lease) throw new Error("expected a lease");
    const fields = role === "preview" ? { imageUrl: url } : { imageUrl: null, iconUrls: [url] };
    expect(await store.recordSnapshot(owner, id, lease.claim, record(fields))).toBe(true);
    expect(await store.writeImage(owner, id, url, role, image)).toBe(true);
  };
  const addCopy = async (owner: OwnerId, id: string, markdown: string, imageUrls: string[] = []) =>
    expect(
      await savedCopies.saveCopy(owner, id, { markdown, imageUrls, nonce: NONCE }, LIMITS, MADE),
    ).toBe("saved");
  const storeImage = async (owner: OwnerId, id: string, n: number, image: ImageBytes) =>
    expect(
      await savedCopies.saveCopyImage(owner, id, n, `https://ex.com/img/${n}`, image, LIMITS),
    ).toBe("saved");
  /** A finished copy holding these images, numbered from 1. */
  const finishedCopy = async (owner: OwnerId, id: string, images: ImageBytes[]) => {
    const refs = images.map((_, k) => `![alt ${k + 1}](${imageRef(k + 1, NONCE)})`).join("\n");
    await addCopy(
      owner,
      id,
      `# Copy of ${id}\n\n${refs}\n`,
      images.map((_, k) => `https://ex.com/img/${k + 1}`),
    );
    for (const [k, image] of images.entries()) await storeImage(owner, id, k + 1, image);
    if (images.length > 0)
      expect(await savedCopies.finishCopy(owner, id, finishedMarkdown, at(51))).toBe(true);
  };
  const storedMarkdown = async (owner: OwnerId, id: string) =>
    ((await savedCopies.readCopy(owner, id)) as ReadCopy).markdown;
  return {
    store,
    profile,
    savedCopies,
    deps,
    save,
    ownPicture,
    pagePicture,
    addCopy,
    storeImage,
    finishedCopy,
    storedMarkdown,
  };
}

/** Builds the owner's zip, validates the real file with unzip and Python, and parses links.json with the manifest schema. */
async function built(deps: ExportDeps, owner: OwnerId, stop: StopFlag = { stopped: false }) {
  const chunks: Uint8Array[] = [];
  const summary = await writeExport(
    deps,
    owner,
    {
      async write(bytes) {
        chunks.push(new Uint8Array(bytes));
      },
    },
    stop,
  );
  const bytes = Buffer.concat(chunks);
  const path = join(dir, `${++zips}.zip`);
  await writeFile(path, bytes);
  validateZip(path);
  const files = readZip(bytes);
  const manifest = manifestSchema.parse(JSON.parse(utf8(files.get("links.json") as Uint8Array)));
  return { files, manifest, summary };
}

const copyFiles = (files: Map<string, Uint8Array>, n: number) =>
  [...files.keys()].filter((k) => k.startsWith(`copies/${n}/`));

describe("writeExport", () => {
  it("writes a version-3 links.json that keeps a put-away and a Tidy-kept link as they are", async () => {
    const h = setup();
    await h.save(A, 1, { state: "archived", putAwayAt: at(300) });
    await h.save(A, 2, { tidyKeptAt: at(400) });
    await h.save(A, 3);
    const { manifest } = await built(h.deps, A);
    expect(manifest.version).toBe(3);
    expect(manifest.links.map((l) => [l.putAwayAt, l.tidyKeptAt])).toEqual([
      [at(300).toISOString(), null],
      [null, at(400).toISOString()],
      [null, null],
    ]);
  });
  it("contents match the manifest both ways; pictures and copies are the stored bytes; copy.md is front matter + Markdown", async () => {
    const h = setup();
    const OWN = pic("image/png", "own-1");
    const PAGE = pic("image/jpeg", "page-1");
    const IMG1 = pic("image/png", "copy-1-image-1");
    const IMG2 = pic("image/gif", "copy-1-image-2");
    const PAGE3 = pic("image/png", "page-3");
    const id1 = await h.save(A, 1, {
      title: "Home batteries",
      tags: [
        { key: "cabin", name: "Cabin", source: "stated", kind: "topic", kindSource: "stated" },
      ],
      why: { text: "Sizing the battery", source: "stated" },
    });
    await h.ownPicture(A, id1, OWN);
    await h.pagePicture(A, id1, PAGE);
    await h.finishedCopy(A, id1, [IMG1, IMG2]);
    await h.save(A, 2);
    const id3 = await h.save(A, 3, { state: "archived" });
    await h.pagePicture(A, id3, PAGE3);
    const STORED_MD = await h.storedMarkdown(A, id1);
    expect(STORED_MD).toBe(
      `# Copy of ${id1}\n\n![alt 1](images/01.png)\n![alt 2](images/02.gif)\n`,
    );
    const link1 = (await h.store.get(A, id1)) as Link;

    const { files, manifest } = await built(h.deps, A);

    const named = manifest.links
      .flatMap((l) => [l.picture?.own, l.picture?.page, l.copy?.file, ...(l.copy?.images ?? [])])
      .filter(Boolean);
    expect([...files.keys()].sort()).toEqual([...named, "links.json", "bookmarks.html"].sort());
    expect(manifest.includesFiles).toBe(true);
    expect(manifest.links.map((l) => [l.picture, l.copy])).toEqual([
      [
        { own: "pictures/1-own.png", page: "pictures/1-page.jpg", pageRole: "preview" },
        {
          status: "ok",
          madeAt: MADE.toISOString(),
          file: "copies/1/copy.md",
          images: ["copies/1/images/01.png", "copies/1/images/02.gif"],
        },
      ],
      [{ own: null, page: null, pageRole: null }, null],
      [{ own: null, page: "pictures/3-page.png", pageRole: "preview" }, null],
    ]);
    expect(files.get("pictures/1-own.png")).toEqual(OWN.bytes);
    expect(files.get("pictures/1-page.jpg")).toEqual(PAGE.bytes);
    expect(files.get("pictures/3-page.png")).toEqual(PAGE3.bytes);
    expect(files.get("copies/1/images/01.png")).toEqual(IMG1.bytes);
    expect(files.get("copies/1/images/02.gif")).toEqual(IMG2.bytes);
    expect(utf8(files.get("copies/1/copy.md") as Uint8Array)).toBe(
      copyWithFrontMatter(link1, MADE, STORED_MD),
    );
    expect(utf8(files.get("bookmarks.html") as Uint8Array)).toBe(
      bookmarksHtml(await h.store.listLinks(A), await h.store.listTags(A), NOW),
    );
    expect([...files.keys()].slice(-2)).toEqual(["links.json", "bookmarks.html"]);
  });

  it("owner isolation: none of B's files, rows or text in A's zip", async () => {
    const h = setup();
    const B_PICTURES = [
      pic("image/png", "B-own-0001"),
      pic("image/jpeg", "B-page-0002"),
      pic("image/webp", "B-copy-image-0003"),
      pic("image/gif", "B-removed-copy-image-0004"),
    ] as const;
    const [bOwn, bPage, bCopyImage, bRemovedImage] = B_PICTURES;
    const zebraTag = {
      key: "zebra",
      name: "Zebra",
      source: "stated",
      kind: "topic",
      kindSource: "stated",
    } as const;
    const b1 = await h.save(B, 901, {
      url: "https://zebra.example/one",
      urlKey: "zebra.example/one",
      title: "zebra title",
      why: { text: "zebra why", source: "stated" },
      tags: [zebraTag],
    });
    const b2 = await h.save(B, 902, {
      url: "https://zebra.example/two",
      urlKey: "zebra.example/two",
    });
    await h.ownPicture(B, b1, bOwn);
    await h.pagePicture(B, b1, bPage);
    await h.finishedCopy(B, b1, [bCopyImage]);
    await h.finishedCopy(B, b2, [bRemovedImage]);
    expect(await h.savedCopies.removeCopy(B, b2, at(60))).toBe(true);
    const ctx = { writtenBy: "zebra-agent", at: at(5), focusLimit: 5, purgeBefore: new Date(0) };
    const r = await h.profile.apply(
      B,
      {
        addNotes: [{ text: "zebra note", source: "stated" }],
        editNotes: [],
        removeNotes: [],
        addFocus: [{ text: "zebra focus", source: "stated" }],
      },
      ctx,
    );
    expect(r.ok).toBe(true);
    const a1 = await h.save(A, 1, { title: "A's own" });
    await h.ownPicture(A, a1, pic("image/png", "A-own"));
    await h.pagePicture(A, a1, pic("image/jpeg", "A-page"));
    await h.finishedCopy(A, a1, [pic("image/png", "A-copy-image")]);

    const { files, manifest } = await built(h.deps, A);

    expect(manifest.links.map((l) => l.title)).toEqual(["A's own"]);
    expect(files.size).toBe(6);
    for (const [, bytes] of files) {
      expect(has(bytes, "zebra")).toBe(false);
      for (const b of B_PICTURES) expect(has(bytes, b.bytes)).toBe(false);
    }
  });

  it("a page picture is never written as the owner's: 'Use the page's picture' after pictureInfo", async () => {
    const h = setup();
    const OWN = pic("image/png", "own");
    const PAGE = pic("image/jpeg", "page");
    const id1 = await h.save(A, 1);
    await h.ownPicture(A, id1, OWN);
    await h.pagePicture(A, id1, PAGE);
    const real = h.store.pictureInfo.bind(h.store);
    const infos: Map<string, PictureInfo>[] = [];
    vi.spyOn(h.store, "pictureInfo").mockImplementation(async (o, ids) => {
      const info = await real(o, ids);
      infos.push(info);
      await h.store.applyEdit(A, id1, { picture: "page" }, at(99));
      return info;
    });

    const { files, manifest } = await built(h.deps, A);

    expect(infos[0]?.get(id1)?.own).toBe(true);
    expect(manifest.links[0]?.picture).toEqual({
      own: null,
      page: "pictures/1-page.jpg",
      pageRole: "preview",
    });
    expect([...files.keys()].filter((k) => k.includes("-own"))).toEqual([]);
    expect([...files].filter(([, b]) => has(b, PAGE.bytes)).map(([k]) => k)).toEqual([
      "pictures/1-page.jpg",
    ]);
  });

  it("a site-icon page picture exports with pageRole icon, read with its bytes, never from pageFit", async () => {
    const h = setup();
    const ICON = pic("image/png", "icon");
    const id1 = await h.save(A, 1);
    await h.pagePicture(A, id1, ICON, "icon");
    const real = h.store.pictureInfo.bind(h.store);
    vi.spyOn(h.store, "pictureInfo").mockImplementation(async (o, ids) => {
      const info = await real(o, ids);
      return new Map([...info].map(([id, i]) => [id, { ...i, pageFit: "cover" as const }]));
    });

    const { files, manifest } = await built(h.deps, A);

    expect(manifest.links[0]?.picture).toEqual({
      own: null,
      page: "pictures/1-page.png",
      pageRole: "icon",
    });
    expect(files.get("pictures/1-page.png")).toEqual(ICON.bytes);
  });

  it.each([
    ["while copy.md is read", "readCopy"],
    ["between two image reads", "copyImage"],
  ] as const)("a copy removed %s gives no copy files and status removed", async (_, method) => {
    const h = setup();
    const id1 = await h.save(A, 1);
    await h.finishedCopy(A, id1, [pic("image/png", "c1"), pic("image/png", "c2")]);
    const remove = async () => {
      expect(await h.savedCopies.removeCopy(A, id1, at(98))).toBe(true);
    };
    if (method === "readCopy") {
      const real = h.savedCopies.readCopy.bind(h.savedCopies);
      vi.spyOn(h.savedCopies, "readCopy").mockImplementationOnce(async (o, id) => {
        const read = await real(o, id);
        await remove();
        return read;
      });
    } else {
      const real = h.savedCopies.copyImage.bind(h.savedCopies);
      vi.spyOn(h.savedCopies, "copyImage").mockImplementationOnce(async (o, id, n) => {
        const image = await real(o, id, n);
        await remove();
        return image;
      });
    }

    const { files, manifest } = await built(h.deps, A);

    expect(copyFiles(files, 1)).toEqual([]);
    expect(manifest.links[0]?.copy).toEqual({
      status: "removed",
      madeAt: MADE.toISOString(),
      file: null,
      images: [],
    });
  });

  it("a copy.md read from another copy than the ledger's first answer gives no copy files and status removed", async () => {
    const h = setup();
    const id1 = await h.save(A, 1);
    await h.finishedCopy(A, id1, [pic("image/png", "c1")]);
    vi.spyOn(h.savedCopies, "copyInfo").mockResolvedValueOnce(new Map([[id1, { madeAt: at(49) }]]));

    const { files, manifest } = await built(h.deps, A);

    expect(copyFiles(files, 1)).toEqual([]);
    expect(manifest.links[0]?.copy).toEqual({
      status: "removed",
      madeAt: MADE.toISOString(),
      file: null,
      images: [],
    });
  });

  it("a copy removed after its link's entries are written stays ok in this export, and is removed in the next", async () => {
    const h = setup();
    const IMG = pic("image/png", "c1");
    const id1 = await h.save(A, 1);
    await h.finishedCopy(A, id1, [IMG]);
    const id2 = await h.save(A, 2);
    await h.ownPicture(A, id2, pic("image/png", "own-2"));
    const real = h.store.image.bind(h.store);
    let removed = false;
    vi.spyOn(h.store, "image").mockImplementation(async (o, id, which) => {
      if (id === id2 && !removed) {
        removed = true;
        expect(await h.savedCopies.removeCopy(A, id1, at(97))).toBe(true);
      }
      return real(o, id, which);
    });

    const first = await built(h.deps, A);

    expect(removed).toBe(true);
    expect(first.manifest.links[0]?.copy).toEqual({
      status: "ok",
      madeAt: MADE.toISOString(),
      file: "copies/1/copy.md",
      images: ["copies/1/images/01.png"],
    });
    expect(copyFiles(first.files, 1).sort()).toEqual([
      "copies/1/copy.md",
      "copies/1/images/01.png",
    ]);
    expect(first.files.get("copies/1/images/01.png")).toEqual(IMG.bytes);

    const next = await built(h.deps, A);

    expect(next.manifest.links[0]?.copy?.status).toBe("removed");
    expect(copyFiles(next.files, 1)).toEqual([]);
  });

  it("a link purged during a build is written without pictures and with copy removed", async () => {
    const h = setup();
    const KEPT = pic("image/png", "own-2");
    const id1 = await h.save(A, 1);
    await h.ownPicture(A, id1, pic("image/png", "own-1"));
    await h.pagePicture(A, id1, pic("image/jpeg", "page-1"));
    await h.finishedCopy(A, id1, [pic("image/png", "c1")]);
    const id2 = await h.save(A, 2);
    await h.ownPicture(A, id2, KEPT);
    const real = h.store.image.bind(h.store);
    let purged = false;
    vi.spyOn(h.store, "image").mockImplementation(async (o, id, which) => {
      if (!purged) {
        purged = true;
        expect(await h.store.markDeleted(A, id1, at(0))).toBe(true);
        await h.savedCopies.purgeRemoved(at(1));
        expect(await h.store.purgeDeleted(at(1))).toBe(1);
      }
      return real(o, id, which);
    });

    const { files, manifest } = await built(h.deps, A);

    expect(purged).toBe(true);
    expect(manifest.links.map((l) => [l.picture, l.copy?.status])).toEqual([
      [{ own: null, page: null, pageRole: null }, "removed"],
      [{ own: "pictures/2-own.png", page: null, pageRole: null }, undefined],
    ]);
    expect(files.get("pictures/2-own.png")).toEqual(KEPT.bytes);
    expect(copyFiles(files, 1)).toEqual([]);
  });

  it("a copy removed and undone during an image read is re-read once and exports ok with every image", async () => {
    const h = setup();
    const IMG1 = pic("image/png", "c1");
    const IMG2 = pic("image/gif", "c2");
    const id1 = await h.save(A, 1);
    await h.finishedCopy(A, id1, [IMG1, IMG2]);
    const real = h.savedCopies.copyImage.bind(h.savedCopies);
    const reads: number[] = [];
    vi.spyOn(h.savedCopies, "copyImage").mockImplementation(async (o, id, n) => {
      reads.push(n);
      if (reads.length > 1) return real(o, id, n);
      expect(await h.savedCopies.removeCopy(A, id1, at(96))).toBe(true);
      const image = await real(o, id, n);
      expect(await h.savedCopies.restoreCopy(A, id1, at(96))).toBe(true);
      return image;
    });

    const { files, manifest } = await built(h.deps, A);

    expect(reads).toEqual([1, 1, 2]);
    expect(manifest.links[0]?.copy).toEqual({
      status: "ok",
      madeAt: MADE.toISOString(),
      file: "copies/1/copy.md",
      images: ["copies/1/images/01.png", "copies/1/images/02.gif"],
    });
    expect(files.get("copies/1/images/01.png")).toEqual(IMG1.bytes);
    expect(files.get("copies/1/images/02.gif")).toEqual(IMG2.bytes);
  });

  it("a copy read that really fails before any stop is still logged, and gives unreadable", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });
    const h = setup();
    const id1 = await h.save(A, 1);
    await h.finishedCopy(A, id1, []);
    vi.spyOn(h.savedCopies, "readCopy").mockRejectedValueOnce(new Error("disk said no"));

    const { manifest } = await built(h.deps, A);

    expect(manifest.links[0]?.copy?.status).toBe("unreadable");
    expect(lines).toEqual([
      expect.stringContaining(`[saved copies] copy ${id1} could not be read: disk said no`),
    ]);
  });

  it("missing and unreadable copy.md: a gone file, a read timeout; no copy files, and the zip validates each time", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const cases = [
      ["missing", (h: ReturnType<typeof setup>, id: string) => h.savedCopies.loseFiles(A, id)],
      ["unreadable", () => {}],
    ] as const;
    for (const [k, [status, breakIt]] of cases.entries()) {
      const timeout: ReadGate = { run: async () => "timeout" as const };
      const h = setup(k === 1 ? timeout : createReadGate());
      const id1 = await h.save(A, 1);
      await h.finishedCopy(A, id1, [pic("image/png", "c1")]);
      breakIt(h, id1);

      const { files, manifest } = await built(h.deps, A);

      expect(copyFiles(files, 1)).toEqual([]);
      expect(manifest.links[0]?.copy).toEqual({
        status,
        madeAt: MADE.toISOString(),
        file: null,
        images: [],
      });
      expect(await h.savedCopies.listCopies(A)).toEqual(
        new Map([[id1, { status: "ok", madeAt: MADE }]]),
      );
    }
    expect(errors.mock.calls.flat().join(" ")).not.toContain("ex.com");
  });

  it("a gone copy image is left out and the copy stays ok: a finished copy.md unchanged, an unfinished one with the alt text", async () => {
    const h = setup();
    const IMG2 = pic("image/gif", "kept-2");
    const id1 = await h.save(A, 1);
    await h.finishedCopy(A, id1, [pic("image/png", "gone-1"), IMG2]);
    const id2 = await h.save(A, 2);
    const unfinished = `![one](${imageRef(1, NONCE)}) ![two](${imageRef(2, NONCE)})`;
    await h.addCopy(A, id2, unfinished, ["https://ex.com/img/1", "https://ex.com/img/2"]);
    await h.storeImage(A, id2, 1, pic("image/png", "gone-2"));
    await h.storeImage(A, id2, 2, pic("image/png", "kept-3"));
    const finishedMd = await h.storedMarkdown(A, id1);
    const real = h.savedCopies.copyImage.bind(h.savedCopies);
    vi.spyOn(h.savedCopies, "copyImage").mockImplementation(async (o, id, n) =>
      n === 1 ? null : real(o, id, n),
    );
    const [link1, link2] = [
      (await h.store.get(A, id1)) as Link,
      (await h.store.get(A, id2)) as Link,
    ];

    const { files, manifest } = await built(h.deps, A);

    expect(manifest.links.map((l) => l.copy)).toEqual([
      {
        status: "ok",
        madeAt: MADE.toISOString(),
        file: "copies/1/copy.md",
        images: ["copies/1/images/02.gif"],
      },
      {
        status: "ok",
        madeAt: MADE.toISOString(),
        file: "copies/2/copy.md",
        images: ["copies/2/images/02.png"],
      },
    ]);
    expect(copyFiles(files, 1).sort()).toEqual(["copies/1/copy.md", "copies/1/images/02.gif"]);
    expect(files.get("copies/1/images/02.gif")).toEqual(IMG2.bytes);
    expect(utf8(files.get("copies/1/copy.md") as Uint8Array)).toBe(
      copyWithFrontMatter(link1, MADE, finishedMd),
    );
    expect(finishedMd).toContain("![alt 1](images/01.png)");
    expect(utf8(files.get("copies/2/copy.md") as Uint8Array)).toBe(
      copyWithFrontMatter(link2, MADE, "![one]() ![two](images/02.png)"),
    );
  });

  it("a copy image read that times out skips the copy's remaining images; the copy stays ok with its text, logged once", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });
    const real = createReadGate();
    let runs = 0;
    // Gate runs in order: copy.md, then image 01, answered "timeout".
    const gate: ReadGate = {
      run: (read, ms) => (++runs === 2 ? Promise.resolve("timeout" as const) : real.run(read, ms)),
    };
    const h = setup(gate);
    const id1 = await h.save(A, 1);
    await h.finishedCopy(A, id1, [
      pic("image/png", "slow-1"),
      pic("image/png", "img-2"),
      pic("image/png", "img-3"),
    ]);
    const md = await h.storedMarkdown(A, id1);
    const link1 = (await h.store.get(A, id1)) as Link;

    const { files, manifest } = await built(h.deps, A);

    expect(runs).toBe(2);
    expect(manifest.links[0]?.copy).toEqual({
      status: "ok",
      madeAt: MADE.toISOString(),
      file: "copies/1/copy.md",
      images: [],
    });
    expect(copyFiles(files, 1)).toEqual(["copies/1/copy.md"]);
    expect(lines.filter((l) => l.includes("could not be read"))).toEqual([
      `[saved copies] copy ${id1} could not be read: timed out`,
    ]);
    expect(utf8(files.get("copies/1/copy.md") as Uint8Array)).toBe(
      copyWithFrontMatter(link1, MADE, md),
    );
  });

  it("an unfinished copy is finished in memory: one ok and one pending image, no nonce left", async () => {
    const h = setup();
    const IMG = pic("image/png", "first");
    const id1 = await h.save(A, 1);
    const markdown = `Look ![one](${imageRef(1, NONCE)}) and ![two](${imageRef(2, NONCE)}).`;
    await h.addCopy(A, id1, markdown, ["https://ex.com/img/1", "https://ex.com/img/2"]);
    await h.storeImage(A, id1, 1, IMG);
    const link1 = (await h.store.get(A, id1)) as Link;

    const { files, manifest } = await built(h.deps, A);

    expect(utf8(files.get("copies/1/copy.md") as Uint8Array)).toBe(
      copyWithFrontMatter(link1, MADE, "Look ![one](images/01.png) and ![two]()."),
    );
    expect(manifest.links[0]?.copy?.images).toEqual(["copies/1/images/01.png"]);
    expect(files.get("copies/1/images/01.png")).toEqual(IMG.bytes);
    for (const [, bytes] of files) expect(has(bytes, NONCE)).toBe(false);
    const stored = (await h.savedCopies.readCopy(A, id1)) as ReadCopy;
    expect(stored).toMatchObject({ markdown, finished: false });
  });

  it("a finished copy is written byte for byte, a reference-like code span and nonce text included", async () => {
    const h = setup();
    const id1 = await h.save(A, 1);
    const markdown = `\`\`\`\n![x](images/03.png)\n\`\`\`\n![y](${imageRef(1, NONCE)})\n`;
    await h.addCopy(A, id1, markdown, ["https://ex.com/img/1"]);
    await h.storeImage(A, id1, 1, pic("image/png", "kept"));
    expect(await h.savedCopies.finishCopy(A, id1, (md) => md, at(51))).toBe(true);
    expect(await h.savedCopies.readCopy(A, id1)).toMatchObject({
      markdown,
      finished: true,
      nonce: NONCE,
    });
    const link1 = (await h.store.get(A, id1)) as Link;

    const { files } = await built(h.deps, A);

    expect(utf8(files.get("copies/1/copy.md") as Uint8Array)).toBe(
      copyWithFrontMatter(link1, MADE, markdown),
    );
  });

  it("stop: set during a pending read, no later read starts, including one queued at the gate; the build throws ExportStopped, logging no read failure", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });
    const gate = createReadGate();
    let exportQueued = () => {};
    const queued = new Promise<void>((resolve) => {
      exportQueued = resolve;
    });
    // The export's gate is the page's gate, noting when the export queues for it.
    const h = setup({
      run: (read, ms) => {
        exportQueued();
        return gate.run(read, ms);
      },
    });
    const id1 = await h.save(A, 1);
    await h.finishedCopy(A, id1, [pic("image/png", "c1")]);
    const id2 = await h.save(A, 2);
    await h.ownPicture(A, id2, pic("image/png", "own-2"));
    const bId = await h.save(B, 9);
    await h.finishedCopy(B, bId, []);

    let pageReading = () => {};
    const pageStarted = new Promise<void>((resolve) => {
      pageReading = resolve;
    });
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const s = h.savedCopies;
    const pageCopies: SavedCopyReader = {
      copyInfo: (o, ids) => s.copyInfo(o, ids),
      listCopies: (o) => s.listCopies(o),
      readCopy: async (o, id) => {
        pageReading();
        await held;
        return s.readCopy(o, id);
      },
      copyImage: (o, id, n) => s.copyImage(o, id, n),
    };
    const page = createCopyReader({ store: h.store, copies: pageCopies, gate }).view(B, bId);
    await pageStarted;

    const readCopy = vi.spyOn(s, "readCopy");
    const copyImage = vi.spyOn(s, "copyImage");
    const copyInfo = vi.spyOn(s, "copyInfo");
    const image = vi.spyOn(h.store, "image");
    const stop = { stopped: false };
    const run = writeExport(h.deps, A, { write: async () => {} }, stop);
    await queued;
    const before = { copyInfo: copyInfo.mock.calls.length, image: image.mock.calls.length };
    stop.stopped = true;
    release();

    await expect(run).rejects.toBeInstanceOf(ExportStopped);
    expect((await page)?.copy).toMatchObject({ markdown: `# Copy of ${bId}\n\n\n` });
    expect(readCopy.mock.calls.filter(([o]) => o === A)).toEqual([]);
    expect(copyImage.mock.calls.filter(([o]) => o === A)).toEqual([]);
    expect(copyInfo.mock.calls.length).toBe(before.copyInfo);
    expect(image.mock.calls.length).toBe(before.image);
    expect(lines.filter((l) => l.includes("could not be read"))).toEqual([]);

    // The stopped build left the gate free: a new build runs to a valid zip.
    const { manifest } = await built(h.deps, A);
    expect(manifest.links[0]?.copy?.status).toBe("ok");
  });

  it("fairness: a copy-page read waits behind at most one build read", async () => {
    const gate = createReadGate();
    const h = setup(gate);
    const id1 = await h.save(A, 1);
    await h.finishedCopy(A, id1, [
      pic("image/png", "c1"),
      pic("image/png", "c2"),
      pic("image/png", "c3"),
    ]);
    const bId = await h.save(B, 9);
    await h.finishedCopy(B, bId, []);
    const pageReader = createCopyReader({ store: h.store, copies: h.savedCopies, gate });
    const events: string[] = [];
    let page: ReturnType<typeof pageReader.view> | undefined;
    const realRead = h.savedCopies.readCopy.bind(h.savedCopies);
    const realImage = h.savedCopies.copyImage.bind(h.savedCopies);
    vi.spyOn(h.savedCopies, "readCopy").mockImplementation(async (o, id) => {
      const who = o === A ? "build:copy.md" : "page";
      events.push(`${who}:start`);
      await nextTurn();
      const read = await realRead(o, id);
      events.push(`${who}:end`);
      return read;
    });
    vi.spyOn(h.savedCopies, "copyImage").mockImplementation(async (o, id, n) => {
      events.push(`build:0${n}:start`);
      if (n === 1) page = pageReader.view(B, bId);
      await nextTurn();
      const image = await realImage(o, id, n);
      events.push(`build:0${n}:end`);
      return image;
    });

    const { manifest } = await built(h.deps, A);

    expect(events).toEqual([
      "build:copy.md:start",
      "build:copy.md:end",
      "build:01:start",
      "build:01:end",
      "page:start",
      "page:end",
      "build:02:start",
      "build:02:end",
      "build:03:start",
      "build:03:end",
    ]);
    expect((await page)?.copy).toMatchObject({ finished: true });
    expect(manifest.links[0]?.copy?.images).toHaveLength(3);
  });

  it("yields between links (setImmediate) and summarises links and files", async () => {
    const h = setup();
    const id1 = await h.save(A, 1);
    await h.ownPicture(A, id1, pic("image/png", "own-1"));
    const id2 = await h.save(A, 2);
    await h.ownPicture(A, id2, pic("image/png", "own-2"));
    const events: string[] = [];
    const real = h.store.image.bind(h.store);
    vi.spyOn(h.store, "image").mockImplementation(async (o, id, which) => {
      events.push(`image:${id}`);
      return real(o, id, which);
    });

    const run = built(h.deps, A);
    setImmediate(() => events.push("tick"));
    const { files, summary } = await run;

    expect(events).toEqual([`image:${id1}`, "tick", `image:${id2}`]);
    expect(summary).toEqual({ exportedAt: NOW, links: 2, files: 4 });
    expect(files.size).toBe(4);
  });
});
