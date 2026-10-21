import { z } from "zod";
import type { ImageType } from "./fetch.js";
import { CHECK_RESULTS, type LinkCheck, type LinkCheckStore } from "./link-check-store.js";
import type { ProfileStore } from "./profile-store.js";
import { IMAGE_EXT, type SavedCopyReader } from "./saved-copy.js";
import type { LinkStore } from "./store.js";
import type { ToolRecord, ToolStore } from "./tool-store.js";
import {
  type FocusEntry,
  type Link,
  type NewLink,
  type OwnerId,
  type ProfileNote,
  SOURCES,
  STATES,
  TAG_KINDS,
  type Tag,
  TOOL_STATUSES,
} from "./types.js";
import { urlKey } from "./url-key.js";

export const EXPORT_FORMAT = "aye-links-export";
export const EXPORT_VERSION = 2;

/** Exactly what `toISOString` writes for a finite date, extended years (`+010000-...`) included: the store keeps any instant. */
const isStoredDate = (s: string) => {
  const t = new Date(s);
  return !Number.isNaN(t.getTime()) && t.toISOString() === s;
};
const date = z.string().refine(isStoredDate, "an ISO timestamp with milliseconds, in UTC");
/** The rule `urlKey` saves by: it throws on what the library refuses (not http or https, or a user name or password). */
const isSavedUrl = (s: string) => {
  try {
    urlKey(s);
    return true;
  } catch {
    return false;
  }
};
const source = z.enum(SOURCES);
/** The image extensions v1 may name. A test checks that every `IMAGE_EXT` value is here, so a new image type fails CI. */
export const V1_IMAGE_EXTS = ["png", "jpg", "gif", "webp"] as const;
const EXTS = V1_IMAGE_EXTS.join("|");
/** One anchored pattern per field (spec, "The zip layout"); group 1 is the link's number. */
const ownPath = new RegExp(`^pictures/([1-9][0-9]*)-own\\.(${EXTS})$`);
const pagePath = new RegExp(`^pictures/([1-9][0-9]*)-page\\.(${EXTS})$`);
const copyFile = /^copies\/([1-9][0-9]*)\/copy\.md$/;
const copyImage = new RegExp(`^copies/([1-9][0-9]*)/images/[0-9]{2}\\.(${EXTS})$`);

export const picturePath = (n: number, which: "own" | "page", type: ImageType) =>
  `pictures/${n}-${which}.${IMAGE_EXT[type]}`;
export const copyFilePath = (n: number) => `copies/${n}/copy.md`;
export const copyImagePath = (n: number, nn: number, type: ImageType) =>
  `copies/${n}/images/${String(nn).padStart(2, "0")}.${IMAGE_EXT[type]}`;
const copySchema = z
  .strictObject({
    status: z.enum(["ok", "missing", "unreadable", "removed"]),
    madeAt: date.nullable(),
    file: z.string().regex(copyFile).nullable(),
    images: z.array(z.string().regex(copyImage)),
  })
  .refine(
    (c) => c.status === "ok" || (c.file === null && c.images.length === 0),
    "only an ok copy names files",
  )
  .refine((c) => c.status !== "ok" || c.madeAt !== null, "an ok copy has madeAt")
  .refine((c) => {
    const nn = c.images.map((p) => Number(/\/images\/([0-9]{2})\./.exec(p)?.[1]));
    return nn.every((n, k) => n >= 1 && (k === 0 || n > (nn[k - 1] as number)));
  }, "images are numbered 01 or more, each higher than the one before");
const linkSchema = z.strictObject({
  url: z.string().refine(isSavedUrl, "only http and https"),
  title: z.string().nullable(),
  summary: z.string().nullable(),
  why: z.strictObject({ text: z.string(), source }).nullable(),
  tags: z.array(z.strictObject({ key: z.string(), name: z.string(), source })),
  state: z.enum(STATES),
  savedAt: date,
  savedBy: z.string(),
  lastOpenedAt: date.nullable(),
  lastSurfacedAt: date.nullable(),
  snoozedUntil: date.nullable(),
  /** Version 2 and later: present there, absent in version 1 (the manifest's check enforces which). */
  putAwayAt: date.nullable().optional(),
  tidyKeptAt: date.nullable().optional(),
  page: z
    .strictObject({
      title: z.string().nullable(),
      description: z.string().nullable(),
      imageUrl: z.string().nullable(),
      fetchedAt: date,
    })
    .nullable(),
  tool: z
    .strictObject({
      status: z.enum(TOOL_STATUSES),
      source,
      since: date,
      answeredAt: date.nullable(),
      waitDays: z.union([z.literal(30), z.literal(60), z.literal(120)]),
    })
    .nullable(),
  check: z
    .strictObject({
      checkedAt: date,
      result: z.enum(CHECK_RESULTS),
      detail: z.string().nullable(),
      firstDeadAt: date.nullable(),
      flaggedAt: date.nullable(),
      stillWorksAt: date.nullable(),
    })
    .nullable(),
  picture: z
    .strictObject({
      own: z.string().regex(ownPath).nullable(),
      page: z.string().regex(pagePath).nullable(),
      pageRole: z.enum(["preview", "icon"]).nullable(),
    })
    .refine(
      (p) => (p.page === null) === (p.pageRole === null),
      "pageRole is null exactly when page is",
    )
    .optional(),
  copy: copySchema.nullable(),
});

/** Versions 1 and 2 of `links.json` (docs/specs/2026-10-18-export-design.md). #131 parses with it; a new key is a new version. */
export const manifestSchema = z
  .strictObject({
    format: z.literal(EXPORT_FORMAT),
    version: z.union([z.literal(1), z.literal(EXPORT_VERSION)]),
    exportedAt: date,
    includesFiles: z.boolean(),
    links: z.array(linkSchema),
    tags: z.array(
      z.strictObject({
        key: z.string(),
        name: z.string(),
        kind: z.enum(TAG_KINDS),
        kindSource: source,
        color: z.string().nullable(),
        pinned: z.boolean(),
        projectStatus: z.enum(["active", "done"]).nullable(),
      }),
    ),
    notes: z.array(
      z.strictObject({ text: z.string(), source, writtenBy: z.string(), updatedAt: date }),
    ),
    focus: z.array(
      z.strictObject({ text: z.string(), source, writtenBy: z.string(), createdAt: date }),
    ),
  })
  .superRefine((m, ctx) => {
    m.links.forEach((l, i) => {
      for (const key of ["putAwayAt", "tidyKeptAt"] as const)
        if ((l[key] !== undefined) !== m.version >= 2)
          ctx.addIssue({
            code: "custom",
            path: ["links", i, key],
            message: "present exactly when the version is 2",
          });
      if (m.includesFiles !== (l.picture !== undefined))
        ctx.addIssue({
          code: "custom",
          path: ["links", i, "picture"],
          message: "picture is present exactly when includesFiles",
        });
      const c = l.copy;
      const numbered = [
        [["picture", "own"], l.picture?.own, ownPath],
        [["picture", "page"], l.picture?.page, pagePath],
        [["copy", "file"], c?.file, copyFile],
        ...(c?.images ?? []).map((img, k) => [["copy", "images", k], img, copyImage] as const),
      ] as const;
      for (const [path, value, pattern] of numbered) {
        if (value && Number(pattern.exec(value)?.[1]) !== i + 1)
          ctx.addIssue({
            code: "custom",
            path: ["links", i, ...path],
            message: "the path's number is the link's position",
          });
      }
      if (m.includesFiles && c?.status === "ok" && c.file === null)
        ctx.addIssue({
          code: "custom",
          path: ["links", i, "copy", "file"],
          message: "a zip export's ok copy names its file",
        });
      if (
        !m.includesFiles &&
        c &&
        (c.status === "missing" ||
          c.status === "unreadable" ||
          c.file !== null ||
          c.images.length > 0)
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["links", i, "copy"],
          message: "a links-only export reads no files",
        });
      }
    });
  });

export type ExportManifest = z.infer<typeof manifestSchema>;
export type ManifestLink = ExportManifest["links"][number];
export type ManifestCopy = NonNullable<ManifestLink["copy"]>;
/** What the manifest is built from. A row whose link is not in `links` is dropped. */
export type ManifestReads = {
  exportedAt: Date;
  links: Link[];
  catalog: Tag[];
  tools: Map<string, ToolRecord>;
  checks: Map<string, LinkCheck>;
  notes: ProfileNote[];
  focus: FocusEntry[];
  copies: Map<string, ManifestCopy>;
  /** Non-null for a zip manifest: the picture paths by link id. A link with no entry has none. */
  pictures: Map<string, NonNullable<ManifestLink["picture"]>> | null;
};

const iso = (d: Date) => d.toISOString();
const isoOrNull = (d: Date | null) => (d === null ? null : d.toISOString());

function manifestLink(link: Link, r: ManifestReads): ManifestLink {
  const tool = r.tools.get(link.id) ?? null;
  const check = r.checks.get(link.id) ?? null;
  const snap = link.snapshot;
  return {
    url: link.url,
    title: link.title,
    summary: link.summary,
    why: link.why && { text: link.why.text, source: link.why.source },
    tags: link.tags.map(({ key, name, source }) => ({ key, name, source })),
    state: link.state,
    savedAt: iso(link.savedAt),
    savedBy: link.savedBy,
    lastOpenedAt: isoOrNull(link.lastOpenedAt),
    lastSurfacedAt: isoOrNull(link.lastSurfacedAt),
    snoozedUntil: isoOrNull(link.snoozedUntil),
    putAwayAt: isoOrNull(link.putAwayAt),
    tidyKeptAt: isoOrNull(link.tidyKeptAt),
    page: snap?.fetchedAt
      ? {
          title: snap.title,
          description: snap.description,
          imageUrl: snap.imageUrl,
          fetchedAt: iso(snap.fetchedAt),
        }
      : null,
    tool: tool && {
      status: tool.status,
      source: tool.source,
      since: iso(tool.since),
      answeredAt: isoOrNull(tool.answeredAt),
      waitDays: tool.waitDays,
    },
    check: check && {
      checkedAt: iso(check.checkedAt),
      result: check.result,
      detail: check.detail,
      firstDeadAt: isoOrNull(check.firstDeadAt),
      flaggedAt: isoOrNull(check.flaggedAt),
      stillWorksAt: isoOrNull(check.stillWorksAt),
    },
    copy: r.copies.get(link.id) ?? null,
    ...(r.pictures && {
      picture: r.pictures.get(link.id) ?? { own: null, page: null, pageRole: null },
    }),
  };
}

/**
 * The manifest as `links.json` holds it. Links-only (`pictures: null`): `includesFiles` is false and no link has
 * `picture`. Zip (`pictures` a map): `includesFiles` is true and every link carries `picture`. Copy file paths
 * come in through `copies`, as the caller wrote them.
 */
export function buildManifest(r: ManifestReads): ExportManifest {
  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: iso(r.exportedAt),
    includesFiles: r.pictures !== null,
    links: r.links.map((link) => manifestLink(link, r)),
    tags: r.catalog.map(({ key, name, kind, kindSource, color, pinned, projectStatus }) => ({
      key,
      name,
      kind,
      kindSource,
      color,
      pinned,
      projectStatus,
    })),
    notes: r.notes.map(({ text, source, writtenBy, updatedAt }) => ({
      text,
      source,
      writtenBy,
      updatedAt: iso(updatedAt),
    })),
    focus: r.focus.map(({ text, source, writtenBy, createdAt }) => ({
      text,
      source,
      writtenBy,
      createdAt: iso(createdAt),
    })),
  };
}

/** A manifest link as the store saves it. A tag the catalog lacks is an inferred topic, as `normalizeTags` makes one. */
export function toNewLink(entry: ManifestLink, catalog: ExportManifest["tags"]): NewLink {
  const kinds = new Map(catalog.map((t) => [t.key, t]));
  const orNull = (s: string | null) => (s === null ? null : new Date(s));
  return {
    url: entry.url,
    urlKey: urlKey(entry.url),
    title: entry.title,
    summary: entry.summary,
    why: entry.why && { text: entry.why.text, source: entry.why.source },
    tags: entry.tags.map((t) => ({
      key: t.key,
      name: t.name,
      source: t.source,
      kind: kinds.get(t.key)?.kind ?? "topic",
      kindSource: kinds.get(t.key)?.kindSource ?? "inferred",
    })),
    savedAt: new Date(entry.savedAt),
    savedBy: entry.savedBy,
    lastOpenedAt: orNull(entry.lastOpenedAt),
    lastSurfacedAt: orNull(entry.lastSurfacedAt),
    snoozedUntil: orNull(entry.snoozedUntil),
    putAwayAt: orNull(entry.putAwayAt ?? null),
    tidyKeptAt: orNull(entry.tidyKeptAt ?? null),
    state: entry.state,
  };
}

/** `aye-links-<UTC date of the export>.<ext>`. */
export const exportFilename = (exportedAt: Date, ext: "json" | "zip") =>
  `aye-links-${exportedAt.toISOString().slice(0, 10)}.${ext}`;

export type ManifestDeps = {
  store: Pick<LinkStore, "listLinks" | "listTags">;
  tools: Pick<ToolStore, "listTools">;
  checks: Pick<LinkCheckStore, "listChecks">;
  profile: Pick<ProfileStore, "listNotes" | "listFocus">;
  savedCopies: Pick<SavedCopyReader, "listCopies">;
  now: () => Date;
};

/** Reads the owner's library, clock first, one owner-scoped read per collection, and builds the links-only manifest. */
export async function exportManifest(deps: ManifestDeps, owner: OwnerId): Promise<ExportManifest> {
  const exportedAt = deps.now();
  const links = await deps.store.listLinks(owner);
  const catalog = await deps.store.listTags(owner);
  const tools = await deps.tools.listTools(owner);
  const checks = await deps.checks.listChecks(owner);
  const notes = await deps.profile.listNotes(owner);
  const focus = await deps.profile.listFocus(owner);
  const ledger = await deps.savedCopies.listCopies(owner);
  const copies = new Map<string, ManifestCopy>(
    [...ledger].map(([id, row]) => [
      id,
      { status: row.status, madeAt: iso(row.madeAt), file: null, images: [] },
    ]),
  );
  return buildManifest({
    exportedAt,
    links,
    catalog,
    tools,
    checks,
    notes,
    focus,
    copies,
    pictures: null,
  });
}

/** JSON leaves U+007F to U+009F, U+2028, U+2029, U+FEFF, U+FFFE and U+FFFF raw, and YAML 1.1 reads some as line breaks. Writes them as \uXXXX. */
const yamlSafe = (v: unknown) =>
  JSON.stringify(v).replace(
    /[\u007f-\u009f\u2028\u2029\ufeff\ufffe\uffff]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );

/** A saved copy's Markdown behind front matter of JSON-quoted values (R13). The title falls back to the page's, then the URL. */
export function copyWithFrontMatter(link: Link, madeAt: Date, markdown: string): string {
  const title = link.title ?? link.snapshot?.title ?? link.url;
  return [
    "---",
    `title: ${yamlSafe(title)}`,
    `url: ${yamlSafe(link.url)}`,
    `saved: ${yamlSafe(iso(link.savedAt))}`,
    `copied: ${yamlSafe(iso(madeAt))}`,
    `tags: ${yamlSafe(link.tags.map((t) => t.name))}`,
    `why: ${yamlSafe(link.why?.text ?? null)}`,
    `why_source: ${yamlSafe(link.why?.source ?? null)}`,
    "---",
    "",
    markdown,
  ].join("\n");
}
