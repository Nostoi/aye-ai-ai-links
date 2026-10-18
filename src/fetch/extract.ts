import { parseHTML } from "linkedom";
import { extractMetadata, type Metadata } from "./extract-metadata.ts";
import { articleText, flattenTemplates, readArticle } from "./extract-text.ts";

// The extraction child loads this file: see AGENTS.md in this folder for the import rules.

export type Snapshot = Metadata & {
  text: string | null;
};

const NO_METADATA: Metadata = { title: null, description: null, imageUrl: null };

/** Parses the HTML with a detached DOM that runs no script and loads nothing. */
export function parsePage(html: string): Document {
  return parseHTML(html).document as unknown as Document;
}

export function pageMetadata(doc: Document, finalUrl: string): Metadata {
  return doc.documentElement ? extractMetadata(doc, finalUrl) : NO_METADATA;
}

export function pageText(doc: Document): string | null {
  if (!doc.documentElement) return null;
  try {
    flattenTemplates(doc);
    const article = readArticle(doc);
    return article ? articleText(article) : null;
  } catch {
    return null;
  }
}

/** Pure: all three steps in one call, for callers that don't need the metadata first. */
export function extractSnapshot(html: string, finalUrl: string): Snapshot {
  const doc = parsePage(html);
  const metadata = pageMetadata(doc, finalUrl);
  return { ...metadata, text: pageText(doc) };
}
