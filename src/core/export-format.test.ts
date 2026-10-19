import { describe, expect, it } from "vitest";
import {
  buildManifest,
  copyFilePath,
  copyImagePath,
  copyWithFrontMatter,
  exportFilename,
  exportManifest,
  type ManifestLink,
  type ManifestReads,
  manifestSchema,
  picturePath,
  toNewLink,
  V1_IMAGE_EXTS,
} from "./export-format.js";
import { FakeProfileStore } from "./fake-profile-store.js";
import { FakeSavedCopies } from "./fake-saved-copies.js";
import { FakeStore } from "./fake-store.js";
import { copyLimits, IMAGE_EXT } from "./saved-copy.js";
import { A, at, B, newLink } from "./snapshot-store-contract.js";
import type { Link, LinkTag, Source, Tag, TagKind } from "./types.js";
import { urlKey } from "./url-key.js";

const T = (s: number) => new Date(Date.UTC(2026, 9, 1) + s * 1000 + 123);
const tag = (
  name: string,
  source: Source,
  kind: TagKind = "topic",
  kindSource: Source = "inferred",
): LinkTag => ({ key: name.toLowerCase(), name, source, kind, kindSource });
const link = (n: number, over: Partial<Link> = {}): Link => ({
  id: String(n),
  url: `https://ex.com/${n}`,
  urlKey: `ex.com/${n}`,
  title: `Title ${n}`,
  summary: null,
  why: null,
  tags: [],
  savedAt: T(n),
  savedBy: "claude-code",
  lastOpenedAt: null,
  lastSurfacedAt: null,
  snoozedUntil: null,
  state: "active",
  snapshot: null,
  ...over,
});
const catalog: Tag[] = [
  {
    key: "cabin",
    name: "Cabin",
    kind: "project",
    kindSource: "stated",
    color: "teal",
    pinned: true,
    description: "never exported",
    projectStatus: "active",
  },
  {
    key: "energy",
    name: "energy",
    kind: "topic",
    kindSource: "inferred",
    color: null,
    pinned: false,
    description: null,
    projectStatus: null,
  },
];
const tool = {
  status: "kept" as const,
  source: "stated" as const,
  since: T(10),
  answeredAt: null,
  waitDays: 60 as const,
};
const ledger = (status: "ok" | "removed", s: number) => ({
  status,
  madeAt: T(s).toISOString(),
  file: null,
  images: [],
});
const reads = (): ManifestReads => ({
  exportedAt: T(1000),
  links: [
    link(1, {
      summary: "Compares batteries",
      why: { text: "Sizing the cabin battery", source: "stated" },
      lastOpenedAt: T(20),
      lastSurfacedAt: T(21),
      tags: [tag("Cabin", "stated", "project", "stated"), tag("energy", "inferred")],
      snapshot: {
        status: "ok",
        fetchedAt: T(2),
        title: "Page",
        description: "Page description",
        imageUrl: "https://ex.com/og.jpg",
      },
    }),
    link(2, { state: "archived" }),
    link(3, { snoozedUntil: T(5000) }),
    link(4, { title: null }),
    link(5, {
      snapshot: {
        status: "pending",
        fetchedAt: null,
        title: null,
        description: null,
        imageUrl: null,
      },
    }),
  ],
  catalog,
  tools: new Map([
    ["1", tool],
    ["999", tool],
  ]),
  checks: new Map([
    [
      "2",
      {
        checkedAt: T(30),
        result: "dead",
        detail: "http:404",
        firstDeadAt: T(30),
        flaggedAt: null,
        stillWorksAt: null,
      },
    ],
  ]),
  notes: [
    {
      id: "7",
      text: "Building a cabin",
      source: "stated",
      writtenBy: "claude-code",
      updatedAt: T(3),
    },
  ],
  focus: [
    { id: "8", text: "Picking a battery", source: "inferred", writtenBy: "codex", createdAt: T(4) },
  ],
  copies: new Map([
    ["1", ledger("ok", 6)],
    ["2", ledger("removed", 7)],
    ["999", ledger("ok", 8)],
  ]),
  pictures: null,
});
const keysDeep = (v: unknown): string[] =>
  Array.isArray(v)
    ? v.flatMap(keysDeep)
    : v && typeof v === "object"
      ? Object.entries(v).flatMap(([k, x]) => [k, ...keysDeep(x)])
      : [];

describe("buildManifest", () => {
  const m = buildManifest(reads());
  it("is a valid v1 links-only manifest, links in list order, in every state", () => {
    expect(manifestSchema.safeParse(m).success).toBe(true);
    expect(m).toMatchObject({
      format: "aye-links-export",
      version: 1,
      exportedAt: T(1000).toISOString(),
      includesFiles: false,
    });
    expect(m.links.map((l) => [l.url, l.state, l.snoozedUntil])).toEqual([
      ["https://ex.com/1", "active", null],
      ["https://ex.com/2", "archived", null],
      ["https://ex.com/3", "active", T(5000).toISOString()],
      ["https://ex.com/4", "active", null],
      ["https://ex.com/5", "active", null],
    ]);
  });
  it("keeps the why, every tag source in attachment order, the page fields, the tool and the copy", () => {
    expect(m.links[0]).toMatchObject({
      why: { text: "Sizing the cabin battery", source: "stated" },
      tags: [
        { key: "cabin", name: "Cabin", source: "stated" },
        { key: "energy", name: "energy", source: "inferred" },
      ],
      page: {
        title: "Page",
        description: "Page description",
        imageUrl: "https://ex.com/og.jpg",
        fetchedAt: T(2).toISOString(),
      },
      tool: {
        status: "kept",
        source: "stated",
        since: T(10).toISOString(),
        answeredAt: null,
        waitDays: 60,
      },
      copy: ledger("ok", 6),
    });
  });
  it("gives page null with no snapshot row and with a pending one (R3)", () => {
    expect([m.links[3]?.page, m.links[4]?.page]).toEqual([null, null]);
  });
  it("drops rows whose link is not in the list, and gives a link with no row null", () => {
    expect(m.links.filter((l) => l.tool !== null)).toHaveLength(1);
    expect(m.links.filter((l) => l.copy !== null)).toHaveLength(2);
    expect(m.links[1]?.check?.detail).toBe("http:404");
    expect(m.links[2]).toMatchObject({ tool: null, check: null, copy: null });
  });
  it("leaves out ids, url keys, the snapshot, tag descriptions and pictures", () => {
    const keys = keysDeep(m);
    for (const k of ["id", "urlKey", "snapshot", "picture"]) expect(keys).not.toContain(k);
    for (const t of m.tags) expect(Object.keys(t)).not.toContain("description");
    expect(JSON.stringify(m)).not.toContain("never exported");
  });
  it("keeps notes and focus with their labels and writers", () => {
    expect(m.notes).toEqual([
      {
        text: "Building a cabin",
        source: "stated",
        writtenBy: "claude-code",
        updatedAt: T(3).toISOString(),
      },
    ]);
    expect(m.focus).toEqual([
      {
        text: "Picking a battery",
        source: "inferred",
        writtenBy: "codex",
        createdAt: T(4).toISOString(),
      },
    ]);
  });
});

describe("manifestSchema", () => {
  const json = () => JSON.parse(JSON.stringify(buildManifest(reads())));
  // biome-ignore lint/suspicious/noExplicitAny: mutating parsed JSON to build refused manifests
  const refuses = (mutate: (m: any) => void) => {
    const m = json();
    mutate(m);
    expect(manifestSchema.safeParse(m).success).toBe(false);
  };
  it("refuses another format, a higher version, and any extra key", () => {
    refuses((m) => {
      m.format = "other";
    });
    refuses((m) => {
      m.version = 2;
    });
    refuses((m) => {
      m.links[0].id = "1";
    });
    refuses((m) => {
      m.tags[0].description = null;
    });
  });
  it("refuses, links-only, pictures, file statuses and files; and anywhere, short dates and other schemes", () => {
    refuses((m) => {
      m.links[0].picture = { own: null, page: null, pageRole: null };
    });
    refuses((m) => {
      m.links[0].copy.status = "missing";
    });
    refuses((m) => {
      m.links[0].copy.file = "copies/1/copy.md";
    });
    refuses((m) => {
      m.links[0].savedAt = "2026-10-01T00:00:01Z";
    });
    refuses((m) => {
      m.links[0].url = "javascript:alert(1)";
    });
  });
  it("accepts a zip manifest whose every link names its pictures", () => {
    const m = json();
    m.includesFiles = true;
    m.links[0].copy.file = "copies/1/copy.md";
    m.links.forEach((l: ManifestLink, i: number) => {
      l.picture = { own: null, page: `pictures/${i + 1}-page.jpg`, pageRole: "preview" };
    });
    expect(manifestSchema.safeParse(m).success).toBe(true);
  });
});

describe("toNewLink", () => {
  const m = buildManifest(reads());
  it("restores a link with the catalog's kinds, a recomputed url key and exact dates", () => {
    const { id: _id, snapshot: _s, ...stored } = reads().links[0] as Link;
    expect(toNewLink(m.links[0] as ManifestLink, m.tags)).toEqual({
      ...stored,
      urlKey: urlKey(stored.url),
    });
  });
  it("restores the surfaced and snooze dates exactly", () => {
    expect(toNewLink(m.links[0] as ManifestLink, m.tags).lastSurfacedAt).toEqual(T(21));
    expect(toNewLink(m.links[2] as ManifestLink, m.tags).snoozedUntil).toEqual(T(5000));
  });
  it("makes a tag missing from the catalog an inferred topic (R5)", () => {
    expect(
      toNewLink(m.links[0] as ManifestLink, []).tags.map((t) => [t.kind, t.kindSource]),
    ).toEqual([
      ["topic", "inferred"],
      ["topic", "inferred"],
    ]);
  });
});

describe("every address and date the library can hold", () => {
  const odd = (url: string, snoozedUntil: Date | null = null) => {
    const r = reads();
    r.links = [link(9, { url, snoozedUntil })];
    return r;
  };
  const written = (r: ManifestReads) => JSON.parse(JSON.stringify(buildManifest(r)));
  const roundTrip = (r: ManifestReads) => {
    const parsed = manifestSchema.parse(written(r));
    return toNewLink(parsed.links[0] as ManifestLink, parsed.tags);
  };
  it.each(["https:example.com/page", "https:/x", "https:\\x"])(
    "round-trips the address %s",
    (url) => {
      expect(roundTrip(odd(url)).url).toBe(url);
    },
  );
  it.each([new Date("+010000-01-01T04:30:00.000Z"), new Date("-000001-12-31T23:30:00.000Z")])(
    "round-trips the date %s",
    (when) => {
      expect(roundTrip(odd("https://ex.com/9", when)).snoozedUntil).toEqual(when);
    },
  );
  it.each(["ftp://x", "not a url"])("still refuses the address %s", (url) => {
    expect(manifestSchema.safeParse(written(odd(url))).success).toBe(false);
  });
  it("refuses a URL with a user name or password, as urlKey does (R12)", () => {
    for (const url of ["https://u:p@ex.com/", "https://u@ex.com/"])
      expect(manifestSchema.safeParse(written(odd(url))).success).toBe(false);
  });
});

describe("exportFilename", () => {
  it("names the file by the UTC date of the export", () => {
    expect(exportFilename(new Date("2026-10-18T23:30:00-05:00"), "json")).toBe(
      "aye-links-2026-10-19.json",
    );
    expect(exportFilename(new Date("2026-10-18T00:00:00.000Z"), "zip")).toBe(
      "aye-links-2026-10-18.zip",
    );
  });
});

describe("exportManifest", () => {
  const NOW = new Date("2026-10-19T08:00:00.250Z");
  const NONCE = "0123456789abcdef0123456789abcdef";
  const setup = () => {
    const store = new FakeStore();
    const profile = new FakeProfileStore();
    const savedCopies = new FakeSavedCopies(store);
    const deps = { store, tools: store, checks: store, profile, savedCopies, now: () => NOW };
    const save = async (owner: string, n: number) =>
      (await store.insertIfAbsent(owner, newLink(n, at(n)))).link.id;
    const addCopy = async (owner: string, id: string) =>
      expect(
        await savedCopies.saveCopy(
          owner,
          id,
          { markdown: "body", imageUrls: [], nonce: NONCE },
          copyLimits(10_000),
          at(50),
        ),
      ).toBe("saved");
    return { deps, profile, savedCopies, save, addCopy };
  };

  it("gives a new owner a valid, empty manifest stamped with the clock (Review Focus 2)", async () => {
    const m = await exportManifest(setup().deps, "nobody");
    expect(manifestSchema.safeParse(m).success).toBe(true);
    expect(m).toMatchObject({
      exportedAt: NOW.toISOString(),
      includesFiles: false,
      links: [],
      tags: [],
      notes: [],
      focus: [],
    });
  });

  it("keeps removed and purged copies as tombstones with the ledger's madeAt (R2), and an undone removal as ok", async () => {
    const { deps, savedCopies, save, addCopy } = setup();
    const ids = [
      await save(A, 1),
      await save(A, 2),
      await save(A, 3),
      await save(A, 4),
      await save(A, 5),
    ];
    const [ok, removed, purged, undone, none] = ids as [string, string, string, string, string];
    for (const id of [ok, removed, purged, undone]) await addCopy(A, id);
    await savedCopies.recordNoCopy(A, none, "none");
    await savedCopies.removeCopy(A, purged, at(60));
    await savedCopies.purgeRemoved(at(61));
    await savedCopies.removeCopy(A, removed, at(62));
    await savedCopies.removeCopy(A, undone, at(63));
    await savedCopies.restoreCopy(A, undone, at(63));
    const m = await exportManifest(deps, A);
    const entry = (status: string) => ({
      status,
      madeAt: at(50).toISOString(),
      file: null,
      images: [],
    });
    expect(m.links.map((l) => l.copy)).toEqual([
      entry("ok"),
      entry("removed"),
      entry("removed"),
      entry("ok"),
      null,
    ]);
    for (const l of m.links) expect("picture" in l).toBe(false);
  });

  it("lists live notes only, the whole focus log oldest first, and none of another owner's", async () => {
    const { deps, profile, save } = setup();
    await save(A, 1);
    await save(B, 2);
    const ctx = (when: Date) => ({
      writtenBy: "x",
      at: when,
      focusLimit: 5,
      purgeBefore: new Date(0),
    });
    const notes = [
      { text: "kept", source: "stated" as const },
      { text: "removed", source: "stated" as const },
    ];
    const addFocus = [...Array(7)].map((_, k) => ({ text: `f${k}`, source: "stated" as const }));
    const r = await profile.apply(
      A,
      { addNotes: notes, editNotes: [], removeNotes: [], addFocus },
      ctx(at(1)),
    );
    if (!r.ok) throw new Error("seed failed");
    await profile.apply(
      A,
      {
        addNotes: [],
        editNotes: [],
        addFocus: [],
        removeNotes: [{ id: r.addedNoteIds[1] as string, expectedSource: "stated" }],
      },
      ctx(at(2)),
    );
    await profile.apply(
      B,
      {
        addNotes: [{ text: "B's note", source: "stated" }],
        editNotes: [],
        removeNotes: [],
        addFocus: [{ text: "B's focus", source: "stated" }],
      },
      ctx(at(3)),
    );
    const m = await exportManifest(deps, A);
    expect(m.notes.map((n) => n.text)).toEqual(["kept"]);
    expect(m.focus.map((f) => f.text)).toEqual(["f0", "f1", "f2", "f3", "f4", "f5", "f6"]);
    expect(m.links).toHaveLength(1);
  });
});

describe("N1: one path pattern per field", () => {
  // biome-ignore lint/suspicious/noExplicitAny: mutating parsed JSON to build refused manifests
  type Json = any;
  const zipJson = (): Json => {
    const m = JSON.parse(JSON.stringify(buildManifest({ ...reads(), pictures: new Map() })));
    m.links[0].copy = {
      status: "ok",
      madeAt: T(6).toISOString(),
      file: "copies/1/copy.md",
      images: ["copies/1/images/01.png"],
    };
    m.links[0].picture = {
      own: "pictures/1-own.png",
      page: "pictures/1-page.jpg",
      pageRole: "icon",
    };
    return m;
  };
  it("pageRole round-trips through the schema, and is null exactly when page is", () => {
    expect(manifestSchema.parse(zipJson()).links[0]?.picture).toEqual({
      own: "pictures/1-own.png",
      page: "pictures/1-page.jpg",
      pageRole: "icon",
    });
    for (const bad of [
      { own: null, page: null, pageRole: "icon" },
      { own: null, page: "pictures/1-page.jpg", pageRole: null },
      { own: null, page: "pictures/1-page.jpg", pageRole: "logo" },
      { own: null, page: null },
    ]) {
      const m = zipJson();
      m.links[0].picture = bad;
      expect(manifestSchema.safeParse(m).success).toBe(false);
    }
  });
  it("accepts each field's own shape", () =>
    expect(manifestSchema.safeParse(zipJson()).success).toBe(true));
  it.each<[string, (m: Json) => void]>([
    ["own holds a page path", (m) => (m.links[0].picture.own = "pictures/1-page.png")],
    ["page holds the copy file", (m) => (m.links[0].picture.page = "copies/1/copy.md")],
    ["file holds an image", (m) => (m.links[0].copy.file = "copies/1/images/01.png")],
    ["images hold copy.md", (m) => (m.links[0].copy.images = ["copies/1/copy.md"])],
    ["a dot-dot segment", (m) => (m.links[0].copy.file = "copies/1/../2/copy.md")],
    ["another link's number", (m) => (m.links[0].picture.own = "pictures/2-own.png")],
    ["an extension outside v1", (m) => (m.links[0].picture.page = "pictures/1-page.svg")],
    ["a number with a leading zero", (m) => (m.links[0].copy.file = "copies/01/copy.md")],
  ])("refuses %s", (_, mutate) => {
    const m = zipJson();
    mutate(m);
    expect(manifestSchema.safeParse(m).success).toBe(false);
  });
  it("a zip manifest's ok copy names its file; a links-only one needs none", () => {
    const m = zipJson();
    m.links[0].copy.file = null;
    expect(manifestSchema.safeParse(m).success).toBe(false);
    const linksOnly = JSON.parse(JSON.stringify(buildManifest(reads())));
    expect(manifestSchema.safeParse(linksOnly).success).toBe(true);
  });
  it.each([
    ["the same path twice", ["copies/1/images/01.png", "copies/1/images/01.png"]],
    ["one number with two extensions", ["copies/1/images/01.png", "copies/1/images/01.jpg"]],
    ["number 00", ["copies/1/images/00.png"]],
    ["02 before 01", ["copies/1/images/02.png", "copies/1/images/01.png"]],
  ])("refuses images with %s", (_, images) => {
    const m = zipJson();
    m.links[0].copy.images = images;
    expect(manifestSchema.safeParse(m).success).toBe(false);
  });
  it("accepts images that skip a number", () => {
    const m = zipJson();
    m.links[0].copy.images = ["copies/1/images/01.png", "copies/1/images/03.webp"];
    expect(manifestSchema.safeParse(m).success).toBe(true);
  });
  it("every image type the app stores has a v1 extension", () =>
    expect(V1_IMAGE_EXTS).toEqual(expect.arrayContaining(Object.values(IMAGE_EXT))));
});

describe("N2: v1's value lists are pinned", () => {
  const link = manifestSchema.shape.links.element.shape;
  const tag = manifestSchema.shape.tags.element.shape;
  it.each([
    ["why source", link.why.unwrap().shape.source.options, ["stated", "asked", "inferred"]],
    ["state", link.state.options, ["active", "archived"]],
    ["tag kind", tag.kind.options, ["topic", "project"]],
    ["project status", tag.projectStatus.unwrap().options, ["active", "done"]],
    ["tool status", link.tool.unwrap().shape.status.options, ["kept", "suggested", "declined"]],
    ["check result", link.check.unwrap().shape.result.options, ["alive", "dead", "unknown"]],
    [
      "copy status",
      link.copy.unwrap().shape.status.options,
      ["ok", "missing", "unreadable", "removed"],
    ],
    [
      "page picture role",
      link.picture.unwrap().shape.pageRole.unwrap().options,
      ["preview", "icon"],
    ],
    ["image extension", V1_IMAGE_EXTS, ["png", "jpg", "gif", "webp"]],
  ])("%s", (_, actual, pinned) => expect([...actual]).toEqual(pinned));
});

describe("buildManifest with pictures", () => {
  it("is a zip manifest: includesFiles, and every link names its pictures", () => {
    const m = buildManifest({
      ...reads(),
      pictures: new Map([["1", { own: "pictures/1-own.png", page: null, pageRole: null }]]),
    });
    expect(m.includesFiles).toBe(true);
    expect(m.links.map((l) => l.picture)).toEqual([
      { own: "pictures/1-own.png", page: null, pageRole: null },
      ...Array(4).fill({ own: null, page: null, pageRole: null }),
    ]);
  });
});

describe("path helpers", () => {
  it("name each file the schema's patterns accept", () => {
    expect(picturePath(3, "own", "image/png")).toBe("pictures/3-own.png");
    expect(picturePath(3, "page", "image/jpeg")).toBe("pictures/3-page.jpg");
    expect(copyFilePath(12)).toBe("copies/12/copy.md");
    expect(copyImagePath(12, 4, "image/webp")).toBe("copies/12/images/04.webp");
  });
});

describe("copyWithFrontMatter", () => {
  const title = 'He said "x": a\nb\r\n--- end\u2028\u2029\u0085\u007f\ufffe\uffff';
  const fm = copyWithFrontMatter(
    link(1, {
      title,
      tags: [tag("Cabin", "stated"), tag("energy", "inferred")],
      why: { text: "Why: #1", source: "inferred" },
    }),
    T(9),
    "# Body\n",
  );
  it("is exactly the front matter, a blank line, then the Markdown", () => {
    expect(fm).toBe(
      [
        "---",
        'title: "He said \\"x\\": a\\nb\\r\\n--- end\\u2028\\u2029\\u0085\\u007f\\ufffe\\uffff"',
        'url: "https://ex.com/1"',
        `saved: "${T(1).toISOString()}"`,
        `copied: "${T(9).toISOString()}"`,
        'tags: ["Cabin","energy"]',
        'why: "Why: #1"',
        'why_source: "inferred"',
        "---",
        "",
        "# Body\n",
      ].join("\n"),
    );
  });
  it("each value JSON-parses back to the original, and only the fences start with ---", () => {
    const head = fm.split("\n---\n")[0]?.split("\n").slice(1) as string[];
    expect(JSON.parse((head[0] as string).slice(7))).toBe(title);
    expect(fm.split("\n").filter((l) => l.startsWith("---"))).toEqual(["---", "---"]);
  });
  it("why and why_source are null without a why; the title falls back to the page's, then the URL", () => {
    const head = (l: Link) => copyWithFrontMatter(l, T(9), "x").split("\n");
    const page = {
      status: "ok" as const,
      fetchedAt: T(2),
      title: "Page title",
      description: null,
      imageUrl: null,
    };
    const a = head(link(1, { title: null, snapshot: page }));
    expect(a[1]).toBe('title: "Page title"');
    expect(a).toContain("why: null");
    expect(a).toContain("why_source: null");
    expect(a).toContain("tags: []");
    expect(head(link(2, { title: null }))[1]).toBe('title: "https://ex.com/2"');
  });
});
