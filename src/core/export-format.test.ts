import { describe, expect, it } from "vitest";
import {
  buildManifest,
  exportFilename,
  type ManifestLink,
  type ManifestReads,
  manifestSchema,
  toNewLink,
} from "./export-format.js";
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
      m.links[0].picture = { own: null, page: null };
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
    for (const l of m.links) l.picture = { own: null, page: "pictures/1-page.jpg" };
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
  it("makes a tag missing from the catalog an inferred topic (R5)", () => {
    expect(
      toNewLink(m.links[0] as ManifestLink, []).tags.map((t) => [t.kind, t.kindSource]),
    ).toEqual([
      ["topic", "inferred"],
      ["topic", "inferred"],
    ]);
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
