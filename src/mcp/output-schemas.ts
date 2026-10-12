import { z } from "zod";
import { SOURCES, STATES, TAG_KINDS } from "../core/types.js";

// The JSON form of core's results: `ok()` in server.ts turns each Date into a string.
// Timestamps are plain strings because `Date#toJSON` is not always a four-digit ISO year.
// Objects are strict so the advertised `additionalProperties: false` is also what the SDK enforces.

const source = z.enum(SOURCES);
const timestamp = z.string();

const labelledOutput = z.strictObject({ text: z.string(), source });
const linkTagOutput = z.strictObject({
  key: z.string(),
  name: z.string(),
  source,
  kind: z.enum(TAG_KINDS),
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
});

export const tagOutput = z.strictObject({
  key: z.string(),
  name: z.string(),
  kind: z.enum(TAG_KINDS),
  color: z.string().nullable(),
  pinned: z.boolean(),
  description: z.string().nullable(),
  projectStatus: z.enum(["active", "done"]).nullable(),
});

const filingContextOutput = z.strictObject({
  tags: z.array(tagOutput),
  activeProjects: z.array(tagOutput),
});

export const saveLinkOutput = z.strictObject({
  link: linkOutput,
  created: z.boolean(),
  filingContext: filingContextOutput,
});
export const linkResultOutput = z.strictObject({ link: linkOutput });
export const searchLinksOutput = z.strictObject({ links: z.array(linkOutput) });
export const updateTagOutput = z.strictObject({ tag: tagOutput });
