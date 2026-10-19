import { z } from "zod";
import { CHECK_RESULTS, type LinkCheck, type LinkCheckStore } from "./link-check-store.js";
import type { ProfileStore } from "./profile-store.js";
import type { SavedCopyReader } from "./saved-copy.js";
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
import { isWebUrl, urlKey } from "./url-key.js";

export const EXPORT_FORMAT = "aye-links-export";
export const EXPORT_VERSION = 1;

const date = z.iso.datetime({ precision: 3 });
const source = z.enum(SOURCES);
/** A path inside the zip: ASCII digits, fixed words and an image extension (spec, "The zip layout"). */
const zipPath = z.string().regex(/^[a-z0-9]+(\/[a-z0-9.-]+)+$/);
const copySchema = z
  .strictObject({
    status: z.enum(["ok", "missing", "unreadable", "removed"]),
    madeAt: date.nullable(),
    file: zipPath.nullable(),
    images: z.array(zipPath),
  })
  .refine(
    (c) => c.status === "ok" || (c.file === null && c.images.length === 0),
    "only an ok copy names files",
  )
  .refine((c) => c.status !== "ok" || c.madeAt !== null, "an ok copy has madeAt");
const linkSchema = z.strictObject({
  url: z.string().refine(isWebUrl, "only http and https"),
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
  picture: z.strictObject({ own: zipPath.nullable(), page: zipPath.nullable() }).optional(),
  copy: copySchema.nullable(),
});

/** Version 1 of `links.json` (docs/specs/2026-10-18-export-design.md). #131 parses with it; a new key is a new version. */
export const manifestSchema = z
  .strictObject({
    format: z.literal(EXPORT_FORMAT),
    version: z.literal(EXPORT_VERSION),
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
      if (m.includesFiles !== (l.picture !== undefined))
        ctx.addIssue({
          code: "custom",
          path: ["links", i, "picture"],
          message: "picture is present exactly when includesFiles",
        });
      const c = l.copy;
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
  };
}

/** The links-only manifest (`includesFiles: false`). PR 2 adds the zip's pictures and copy files. */
export function buildManifest(r: ManifestReads): ExportManifest {
  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: iso(r.exportedAt),
    includesFiles: false,
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
  return buildManifest({ exportedAt, links, catalog, tools, checks, notes, focus, copies });
}
