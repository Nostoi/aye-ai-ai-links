import { createHash } from "node:crypto";
import { capCodePoints } from "./snapshot-text.js";

/** Code points of the summary that go into a link's document. */
export const SUMMARY_CHARS = 1000;
/** Code points of page title, description and text together, with their line breaks. */
export const PAGE_CHARS = 1500;

/** What a link's document is built from: its own fields, its URL and its page snapshot. */
export type DocumentInput = {
  url: string;
  title: string | null;
  summary: string | null;
  why: string | null;
  /** Tag names, in the link's order. */
  tags: string[];
  pageTitle: string | null;
  pageDescription: string | null;
  pageText: string | null;
};

const present = (parts: (string | null)[]): string[] =>
  parts.filter((p): p is string => p !== null && p.trim() !== "");

/**
 * The text a link is embedded from, one part per line, empty parts left out. The owner's
 * fields come first and whole (title, why, tags; the summary up to `SUMMARY_CHARS`), then the
 * URL, so a document is never empty. The page's title, description and text share
 * `PAGE_CHARS`, which only ever cuts them. The model reads only its first 512 tokens: a very
 * long owner field can push the rest out of its view, but still changes the hash.
 */
export function linkDocument(input: DocumentInput): string {
  const tags = input.tags.join(", ");
  const summary = input.summary === null ? null : capCodePoints(input.summary, SUMMARY_CHARS).text;
  const own = present([input.title, input.why, tags, summary, input.url]);
  const page = present([input.pageTitle, input.pageDescription, input.pageText]).join("\n");
  const cut = capCodePoints(page, PAGE_CHARS).text;
  return [...own, ...present([cut])].join("\n");
}

/** Changes whenever the document or the model does, so either one causes a re-embed. */
export function documentHash(modelKey: string, doc: string): string {
  return createHash("sha256").update(`${modelKey}\n${doc}`).digest("hex");
}
