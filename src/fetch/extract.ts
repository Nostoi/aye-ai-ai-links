import { parseHTML } from "linkedom";
import { extractMetadata, type Metadata } from "./extract-metadata.js";
import { articleText, flattenTemplates } from "./extract-text.js";

export type Snapshot = Metadata & {
  text: string | null;
};

/** Pure: parses the HTML with a detached DOM that runs no script and loads nothing. */
export function extractSnapshot(html: string, finalUrl: string): Snapshot {
  const { document } = parseHTML(html);
  const doc = document as unknown as Document;
  if (!doc.documentElement) return { title: null, description: null, imageUrl: null, text: null };
  const metadata = extractMetadata(doc, finalUrl);
  try {
    flattenTemplates(doc);
    return { ...metadata, text: articleText(doc) };
  } catch {
    return { ...metadata, text: null };
  }
}
