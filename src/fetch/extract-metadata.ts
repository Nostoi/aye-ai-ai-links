import { MAX_ICON_URLS } from "../core/snapshot-store.ts";
import { capCodePoints } from "./cap.ts";

const TITLE_MAX = 500;
const DESCRIPTION_MAX = 1_000;
const URL_MAX = 2_048;

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

/** `value` resolved against `base`: http or https, with no username or password, at most URL_MAX characters. */
function usableUrl(value: string, base: string): URL | null {
  const u = parseUrl(value, base);
  const web = u && (u.protocol === "http:" || u.protocol === "https:");
  return web && !u.username && !u.password && u.href.length <= URL_MAX ? u : null;
}

function imageUrl(doc: Document, base: string): string | null {
  return firstUsable(
    [...metaContents(doc, "og:image", urlValue), ...metaContents(doc, "twitter:image", urlValue)],
    (v) => usableUrl(v, base)?.href ?? null,
  );
}

// `fluid-icon` is GitHub's: its only icon of 64 px or more (#193).
const ICON_RELS = ["icon", "apple-touch-icon", "apple-touch-icon-precomposed", "fluid-icon"];
const ICON_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
const ASCII_SPACE = /[\t\n\f\r ]+/;

/** The largest min(W, H) among a `sizes` value's valid `WxH` entries; null when it has none. */
function declaredSize(sizes: string | null): number | null {
  let best: number | null = null;
  for (const entry of (sizes ?? "").split(ASCII_SPACE)) {
    const m = /^([1-9][0-9]*)[xX]([1-9][0-9]*)$/.exec(entry);
    if (!m) continue;
    const side = Math.min(Number(m[1]), Number(m[2]));
    if (best === null || side > best) best = side;
  }
  return best;
}

/** Whether the declaration may be a kept type: by its `type`, else by its path's extension. */
function keptType(link: Element, url: URL): boolean {
  const type = link.getAttribute("type");
  if (type !== null) return ICON_TYPES.includes(type.split(";")[0]?.trim().toLowerCase() ?? "");
  return !/\.(svg|ico)$/i.test(url.pathname);
}

/** The site's icon candidates, best first: sized largest first, then unsized; the later declaration wins a tie. */
function iconUrls(doc: Document, base: string): string[] {
  const found: { href: string; size: number; order: number }[] = [];
  for (const [order, link] of [...doc.querySelectorAll("link")].entries()) {
    const rel = (link.getAttribute("rel") ?? "").toLowerCase().split(ASCII_SPACE);
    if (!rel.some((t) => ICON_RELS.includes(t)) || link.hasAttribute("media")) continue;
    const href = urlValue(link.getAttribute("href"));
    const url = href === null ? null : usableUrl(href, base);
    if (!url || !keptType(link, url)) continue;
    // 0 sorts an unsized declaration after every sized one: a valid size is at least 1.
    found.push({ href: url.href, size: declaredSize(link.getAttribute("sizes")) ?? 0, order });
  }
  found.sort((a, b) => b.size - a.size || b.order - a.order);
  return [...new Set(found.map((f) => f.href))].slice(0, MAX_ICON_URLS);
}

export type Metadata = {
  title: string | null;
  description: string | null;
  imageUrl: string | null;
  iconUrls: string[];
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
  const base = documentBase(doc, finalUrl);
  return {
    title: title && capCodePoints(title, TITLE_MAX),
    description: description && capCodePoints(description, DESCRIPTION_MAX),
    imageUrl: imageUrl(doc, base),
    iconUrls: iconUrls(doc, base),
  };
}
