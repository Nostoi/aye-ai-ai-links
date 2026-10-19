import { parseHTML } from "linkedom";
import { extractMetadata, type Metadata } from "./extract-metadata.ts";
import { articleText, flattenTemplates, readArticle } from "./extract-text.ts";

// The extraction child loads this file: see AGENTS.md in this folder for the import rules.

export type Snapshot = Metadata & {
  text: string | null;
};

const NO_METADATA: Metadata = { title: null, description: null, imageUrl: null, iconUrls: [] };

/** Parses the HTML with a detached DOM that runs no script and loads nothing. */
export function parsePage(html: string): Document {
  return parseHTML(html).document as unknown as Document;
}

export function pageMetadata(doc: Document, finalUrl: string): Metadata {
  return doc.documentElement ? extractMetadata(doc, finalUrl) : NO_METADATA;
}

/** The readable text and the article element it came from; `article` is null whenever `text` is. */
export function pageArticle(doc: Document): { text: string | null; article: Element | null } {
  if (!doc.documentElement) return { text: null, article: null };
  try {
    flattenTemplates(doc);
    const article = readArticle(doc);
    const text = article ? articleText(article) : null;
    return text === null ? { text: null, article: null } : { text, article };
  } catch {
    return { text: null, article: null };
  }
}

export function pageText(doc: Document): string | null {
  return pageArticle(doc).text;
}

/** Pure: all three steps in one call, for callers that don't need the metadata first. */
export function extractSnapshot(html: string, finalUrl: string): Snapshot {
  const doc = parsePage(html);
  const metadata = pageMetadata(doc, finalUrl);
  return { ...metadata, text: pageText(doc) };
}
