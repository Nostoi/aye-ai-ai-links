export const SOURCES = ["stated", "asked", "inferred"] as const;
export type Source = (typeof SOURCES)[number];
export const TAG_KINDS = ["topic", "project"] as const;
export type TagKind = (typeof TAG_KINDS)[number];
export const STATES = ["active", "archived"] as const;
export type LinkState = (typeof STATES)[number];
/** Who wrote a summary: the owner (stated, asked), an AI on its own (inferred), or the server. */
export const SUMMARY_SOURCES = [...SOURCES, "server"] as const;
export type SummarySource = (typeof SUMMARY_SOURCES)[number];
export type Labelled = { text: string; source: Source };
export type OwnerId = string;
export const SNAPSHOT_STATUSES = [
  "pending",
  "retrying",
  "ok",
  "failed",
  "refused",
  "not_html",
  "extract_timeout",
  "extract_out_of_memory",
  "extract_crashed",
] as const;
export type SnapshotStatus = (typeof SNAPSHOT_STATUSES)[number];

export const TOOL_STATUSES = ["kept", "suggested", "declined"] as const;
export type ToolStatus = (typeof TOOL_STATUSES)[number];

/** What a link's event log records (#161). */
export type LinkEventKind = "opened" | "put_away" | "stale" | "not_now" | "not_handy";

/** What a fetch of the page produced, without its text (see SnapshotStore.getSnapshotText). */
export type SnapshotSummary = {
  status: SnapshotStatus;
  fetchedAt: Date | null;
  title: string | null;
  description: string | null;
  imageUrl: string | null;
};

/**
 * key is the identity (lower-cased name); name is for display. `source` labels this attachment.
 * `kindSource` says who decided the tag's kind: on a write it is used only when the tag is new;
 * on a read it is the catalog's (see `Tag.kindSource`).
 */
export type LinkTag = {
  key: string;
  name: string;
  source: Source;
  kind: TagKind;
  kindSource: Source;
};

export type Link = {
  id: string;
  url: string;
  urlKey: string;
  title: string | null;
  summary: string | null;
  /** Null for no summary, and for one written before sources were recorded; set only with a summary. */
  summarySource: SummarySource | null;
  why: Labelled | null;
  tags: LinkTag[];
  savedAt: Date;
  savedBy: string;
  lastOpenedAt: Date | null;
  lastSurfacedAt: Date | null;
  snoozedUntil: Date | null;
  /** Set only on an archived link the owner put away; null on a stale or active one. */
  putAwayAt: Date | null;
  /** When Tidy up last kept this link; internal, never sent over MCP. */
  tidyKeptAt: Date | null;
  state: LinkState;
  /** Null only for a link that has no snapshot row. */
  snapshot: SnapshotSummary | null;
};

export type Tag = {
  key: string;
  name: string;
  kind: TagKind;
  /** Who decided `kind`: "inferred" means an agent guessed it; an inferred project is shown as a guess. */
  kindSource: Source;
  color: string | null;
  pinned: boolean;
  description: string | null;
  projectStatus: "active" | "done" | null;
};

/** Catalog fields a tag patch may set; an absent field is left untouched. */
export type TagPatch = Partial<Pick<Tag, "kind" | "kindSource" | "projectStatus">>;

export type NewLink = Omit<Link, "id" | "snapshot">;

/**
 * Fields a patch may set; an absent (undefined) field is left untouched. A `summary` written
 * without a `summarySource` is unlabelled. With `summaryOver`, the summary and its source are
 * written only while the row's summary source is one of those listed (null for none), decided in
 * the same write; the rest of the patch is written either way.
 */
export type LinkPatch = Partial<
  Pick<
    Link,
    | "title"
    | "summary"
    | "summarySource"
    | "why"
    | "tags"
    | "state"
    | "snoozedUntil"
    | "lastOpenedAt"
    | "putAwayAt"
    | "tidyKeptAt"
  >
> & { summaryOver?: (SummarySource | null)[] };

/** A note about the owner. `source` says how the writer learned it. */
export type ProfileNote = {
  id: string;
  text: string;
  source: Source;
  writtenBy: string;
  updatedAt: Date;
};

/** What the owner is working on now, dated and labelled like a note. */
export type FocusEntry = {
  id: string;
  text: string;
  source: Source;
  writtenBy: string;
  createdAt: Date;
};
