export const SOURCES = ["stated", "asked", "inferred"] as const;
export type Source = (typeof SOURCES)[number];
export const TAG_KINDS = ["topic", "project"] as const;
export type TagKind = (typeof TAG_KINDS)[number];
export const STATES = ["active", "archived"] as const;
export type LinkState = (typeof STATES)[number];
export type Labelled = { text: string; source: Source };
export type OwnerId = string;

/** key is the identity (lower-cased name); name is for display. */
export type LinkTag = { key: string; name: string; source: Source; kind: TagKind };

export type Link = {
  id: string;
  url: string;
  urlKey: string;
  title: string | null;
  summary: string | null;
  why: Labelled | null;
  tags: LinkTag[];
  savedAt: Date;
  savedBy: string;
  lastOpenedAt: Date | null;
  lastSurfacedAt: Date | null;
  snoozedUntil: Date | null;
  state: LinkState;
};

export type Tag = {
  key: string;
  name: string;
  kind: TagKind;
  color: string | null;
  pinned: boolean;
  description: string | null;
  projectStatus: "active" | "done" | null;
};

/** Catalog fields a tag patch may set; an absent field is left untouched. */
export type TagPatch = Partial<Pick<Tag, "kind" | "projectStatus">>;

export type NewLink = Omit<Link, "id">;

/** Fields a patch may set; an absent (undefined) field is left untouched. */
export type LinkPatch = Partial<
  Pick<Link, "summary" | "why" | "tags" | "state" | "snoozedUntil" | "lastOpenedAt">
>;
