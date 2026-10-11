import { capCodePoints } from "./cap.js";

const TITLE_MAX = 500;
const DESCRIPTION_MAX = 1_000;

function clean(value: string | null | undefined): string | null {
  const v = value?.replace(/\s+/g, " ").trim();
  return v ? v : null;
}

function metaContents(doc: Document, key: string): (string | null)[] {
  return [...doc.querySelectorAll("meta")]
    .filter((m) => m.getAttribute("property") === key || m.getAttribute("name") === key)
    .map((m) => clean(m.getAttribute("content")));
}

function firstUsable<T>(candidates: Iterable<string | null>, accept: (v: string) => T | null) {
  for (const c of candidates) {
    if (c === null) continue;
    const v = accept(c);
    if (v !== null) return v;
  }
  return null;
}

function parseUrl(value: string, base: string): URL | null {
  try {
    return new URL(value, base);
  } catch {
    return null;
  }
}

function documentBase(doc: Document, finalUrl: string): string {
  const href = clean(doc.querySelector("base[href]")?.getAttribute("href"));
  return (href && parseUrl(href, finalUrl)?.href) || finalUrl;
}

function imageUrl(doc: Document, finalUrl: string): string | null {
  const base = documentBase(doc, finalUrl);
  return firstUsable(
    [...metaContents(doc, "og:image"), ...metaContents(doc, "twitter:image")],
    (v) => {
      const u = parseUrl(v, base);
      const ok = u && (u.protocol === "http:" || u.protocol === "https:");
      return ok && !u.username && !u.password ? u.href : null;
    },
  );
}

export type Metadata = {
  title: string | null;
  description: string | null;
  imageUrl: string | null;
};

export function extractMetadata(doc: Document, finalUrl: string): Metadata {
  const text = (v: string) => v;
  const title = firstUsable(
    [...metaContents(doc, "og:title"), clean(doc.querySelector("title")?.textContent)],
    text,
  );
  const description = firstUsable(
    [...metaContents(doc, "og:description"), ...metaContents(doc, "description")],
    text,
  );
  return {
    title: title && capCodePoints(title, TITLE_MAX),
    description: description && capCodePoints(description, DESCRIPTION_MAX),
    imageUrl: imageUrl(doc, finalUrl),
  };
}
