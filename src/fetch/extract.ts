import { parseHTML } from "linkedom";
import { extractMetadata, type Metadata } from "./extract-metadata.js";
import { articleText, flattenTemplates, isParsable } from "./extract-text.js";

export type Snapshot = Metadata & {
  text: string | null;
  textSkipped?: "too_complex";
};

/** Pure: parses the HTML with a detached DOM that runs no script and loads nothing. */
export function extractSnapshot(html: string, finalUrl: string): Snapshot {
  const { document } = parseHTML(html);
  const doc = document as unknown as Document;
  const metadata = extractMetadata(doc, finalUrl);
  if (!isParsable(doc)) return { ...metadata, text: null, textSkipped: "too_complex" };
  flattenTemplates(doc);
  return { ...metadata, text: articleText(doc) };
}
