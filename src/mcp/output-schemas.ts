import type { StandardSchemaWithJSON } from "@modelcontextprotocol/server";
import { z } from "zod";
import { SNAPSHOT_STATUSES, SOURCES, STATES, TAG_KINDS } from "../core/types.js";

// The JSON form of core's results: `ok()` in server.ts turns each Date into a string.
// Timestamps are plain strings because `Date#toJSON` is not always a four-digit ISO year.
// Objects are strict: the server checks the exact shape. Clients see `advertisedOpen` of it.

/** Deletes every `additionalProperties: false` in a JSON Schema, leaving all else as it is. */
function allowExtraKeys(json: unknown): unknown {
  if (Array.isArray(json)) return json.map(allowExtraKeys);
  if (json === null || typeof json !== "object") return json;
  return Object.fromEntries(
    Object.entries(json)
      .filter(([key, value]) => !(key === "additionalProperties" && value === false))
      .map(([key, value]) => [key, allowExtraKeys(value)]),
  );
}

/**
 * The same schema, but its JSON Schema for `tools/list` lets objects carry extra keys,
 * so a client that cached an earlier list still accepts a result with a field added later.
 * Validation stays strict.
 */
export function advertisedOpen<T extends z.ZodType>(
  strict: T,
): StandardSchemaWithJSON<z.input<T>, z.output<T>> {
  const std = strict["~standard"];
  return {
    "~standard": {
      version: std.version,
      vendor: std.vendor,
      validate: (value) => std.validate(value),
      jsonSchema: {
        input: (options) => std.jsonSchema.input(options),
        output: (options) =>
          allowExtraKeys(std.jsonSchema.output(options)) as Record<string, unknown>,
      },
    },
  };
}

const source = z.enum(SOURCES);
const timestamp = z.string();

const labelledOutput = z.strictObject({ text: z.string(), source });
const linkTagOutput = z.strictObject({
  key: z.string(),
  name: z.string(),
  source,
  kind: z.enum(TAG_KINDS),
  kindSource: source,
});

// What a page fetch produced, never its text. Adding a status is a breaking change (ROADMAP #39).
const snapshotOutput = z.strictObject({
  status: z.enum(SNAPSHOT_STATUSES),
  fetchedAt: timestamp.nullable(),
  title: z.string().nullable(),
  description: z.string().nullable(),
  imageUrl: z.string().nullable(),
});

export const linkOutput = z.strictObject({
  id: z.string(),
  url: z.string(),
  urlKey: z.string(),
  title: z.string().nullable(),
  summary: z.string().nullable(),
  why: labelledOutput.nullable(),
  tags: z.array(linkTagOutput),
  savedAt: timestamp,
  savedBy: z.string(),
  lastOpenedAt: timestamp.nullable(),
  lastSurfacedAt: timestamp.nullable(),
  snoozedUntil: timestamp.nullable(),
  state: z.enum(STATES),
  snapshot: snapshotOutput.nullable(),
});

export const tagOutput = z.strictObject({
  key: z.string(),
  name: z.string(),
  kind: z.enum(TAG_KINDS),
  kindSource: source,
  color: z.string().nullable(),
  pinned: z.boolean(),
  description: z.string().nullable(),
  projectStatus: z.enum(["active", "done"]).nullable(),
});

const filingContextOutput = z.strictObject({
  tags: z.array(tagOutput),
  activeProjects: z.array(tagOutput),
});

const profileNoteOutput = z.strictObject({
  id: z.string(),
  text: z.string(),
  source,
  writtenBy: z.string(),
  updatedAt: timestamp,
});
const focusEntryOutput = z.strictObject({
  id: z.string(),
  text: z.string(),
  source,
  writtenBy: z.string(),
  createdAt: timestamp,
});
const profileShape = {
  notes: z.array(profileNoteOutput),
  recentFocus: z.array(focusEntryOutput),
};

/** The notes and recent focus: `save_link`'s `profile`, and what `edit_profile` returns. */
export const profileOutput = z.strictObject(profileShape);
export const getProfileOutput = z.strictObject({
  ...profileShape,
  activeProjects: z.array(tagOutput),
});
export const addProfileOutput = z.strictObject({
  ...profileShape,
  addedNoteIds: z.array(z.string()),
  addedFocusIds: z.array(z.string()),
});

// The page's text, which `snapshotOutput` never carries: an opening excerpt or a capped read.
const snapshotTextOutput = z.strictObject({ text: z.string(), truncated: z.boolean() }).nullable();

export const saveLinkOutput = z.strictObject({
  link: linkOutput,
  created: z.boolean(),
  snapshotText: snapshotTextOutput,
  filingContext: filingContextOutput,
  profile: profileOutput,
});
export const linkResultOutput = z.strictObject({ link: linkOutput });
export const getLinkOutput = z.strictObject({ link: linkOutput, snapshotText: snapshotTextOutput });
export const searchLinksOutput = z.strictObject({ links: z.array(linkOutput) });
export const updateTagOutput = z.strictObject({ tag: tagOutput });
