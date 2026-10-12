import { capCodePoints } from "./cap.ts";

const TITLE_MAX = 500;
const DESCRIPTION_MAX = 1_000;
const IMAGE_URL_MAX = 2_048;

function clean(value: string | null | undefined): string | null {
  const v = value?.replace(/\s+/g, " ").trim();
  return v ? v : null;
}

function urlValue(value: string | null | undefined): string | null {
  const v = value?.replace(/[\t\n\r]/g, "").trim();
  return v ? v : null;
}

const HTML_NS = "http://www.w3.org/1999/xhtml";

function metaContents(
  doc: Document,
  key: string,
  read: (v: string | null) => string | null = clean,
): (string | null)[] {
  const is = (attr: string | null) => attr?.toLowerCase() === key;
  return [...doc.querySelectorAll("meta")]
    .filter((m) => is(m.getAttribute("property")) || is(m.getAttribute("name")))
    .map((m) => read(m.getAttribute("content")));
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
  const href = urlValue(doc.querySelector("base[href]")?.getAttribute("href"));
  return (href && parseUrl(href, finalUrl)?.href) || finalUrl;
}

function imageUrl(doc: Document, finalUrl: string): string | null {
  const base = documentBase(doc, finalUrl);
  return firstUsable(
    [...metaContents(doc, "og:image", urlValue), ...metaContents(doc, "twitter:image", urlValue)],
    (v) => {
      const u = parseUrl(v, base);
      const ok = u && (u.protocol === "http:" || u.protocol === "https:");
      return ok && !u.username && !u.password && u.href.length <= IMAGE_URL_MAX ? u.href : null;
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
  const htmlTitle = [...doc.querySelectorAll("title")].find((t) => t.namespaceURI === HTML_NS);
  const title = firstUsable(
    [...metaContents(doc, "og:title"), clean(htmlTitle?.textContent)],
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
