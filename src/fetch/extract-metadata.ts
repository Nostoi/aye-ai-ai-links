import { MAX_FAVICON_URLS, MAX_ICON_URLS, rootFaviconUrls } from "../core/snapshot-store.ts";
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

// An ICO is a favicon candidate only (#272): the large picture's icons never take one.
const ICO_TYPES = ["image/x-icon", "image/vnd.microsoft.icon"];

/** The declaration's kind, by its `type`, else by its path's extension: a kept picture type, an ICO, or neither. */
function iconKind(link: Element, url: URL): "picture" | "ico" | null {
  const type = link.getAttribute("type");
  if (type !== null) {
    const t = type.split(";")[0]?.trim().toLowerCase() ?? "";
    return ICON_TYPES.includes(t) ? "picture" : ICO_TYPES.includes(t) ? "ico" : null;
  }
  if (/\.ico$/i.test(url.pathname)) return "ico";
  return /\.svg$/i.test(url.pathname) ? null : "picture";
}

type Declared = { href: string; size: number; order: number; ico: boolean; relIcon: boolean };

/** A favicon is shown at 18 px, about 36 on a dense screen: from this size up, smaller is better. */
const FAVICON_GOOD_PX = 32;

/** 0: at least FAVICON_GOOD_PX; 1: sized smaller; 2: unsized. */
const faviconBand = (d: Declared) => (d.size >= FAVICON_GOOD_PX ? 0 : d.size > 0 ? 1 : 2);

/**
 * The favicons' order (#272, after raycast's `bestIcon`): sizes of at least FAVICON_GOOD_PX
 * smallest first, then smaller sizes largest first, then unsized, `rel=icon` before the
 * apple-touch kinds; the later declaration wins any tie left.
 */
function faviconOrder(a: Declared, b: Declared): number {
  const band = faviconBand(a) - faviconBand(b);
  if (band !== 0) return band;
  if (faviconBand(a) === 0) return a.size - b.size || b.order - a.order;
  if (faviconBand(a) === 1) return b.size - a.size || b.order - a.order;
  return Number(b.relIcon) - Number(a.relIcon) || b.order - a.order;
}

/**
 * Every usable icon the page declares, in two orders. `icons`, the large picture's, never take an
 * ICO: sized largest first, then unsized, the later declaration winning a tie. `favicons` take
 * ICOs too, in `faviconOrder`.
 */
function rankedIcons(doc: Document, base: string): { icons: string[]; favicons: string[] } {
  const found: Declared[] = [];
  for (const [order, link] of [...doc.querySelectorAll("link")].entries()) {
    const rel = (link.getAttribute("rel") ?? "").toLowerCase().split(ASCII_SPACE);
    if (!rel.some((t) => ICON_RELS.includes(t)) || link.hasAttribute("media")) continue;
    const href = urlValue(link.getAttribute("href"));
    const url = href === null ? null : usableUrl(href, base);
    const kind = url && iconKind(link, url);
    if (!url || !kind) continue;
    // 0 sorts an unsized declaration after every sized one: a valid size is at least 1.
    const size = declaredSize(link.getAttribute("sizes")) ?? 0;
    found.push({ href: url.href, size, order, ico: kind === "ico", relIcon: rel.includes("icon") });
  }
  const hrefs = (list: Declared[]) => [...new Set(list.map((f) => f.href))];
  const icons = found.filter((f) => !f.ico).sort((a, b) => b.size - a.size || b.order - a.order);
  return { icons: hrefs(icons), favicons: hrefs([...found].sort(faviconOrder)) };
}

/**
 * The favicon candidates (#272): the best declared ones, or, when the page has no usable one,
 * the site root's (`rootFaviconUrls`), from the final URL, never the document's `<base href>`.
 */
export function faviconCandidates(declared: string[], finalUrl: string): string[] {
  return declared.length > 0 ? declared.slice(0, MAX_FAVICON_URLS) : rootFaviconUrls(finalUrl);
}

export type Metadata = {
  title: string | null;
  description: string | null;
  imageUrl: string | null;
  /** The large picture's icon candidates (#149): the best MAX_ICON_URLS. */
  iconUrls: string[];
  /** The favicon candidates (#272): see `faviconCandidates`. */
  faviconUrls: string[];
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
  const icons = rankedIcons(doc, base);
  return {
    title: title && capCodePoints(title, TITLE_MAX),
    description: description && capCodePoints(description, DESCRIPTION_MAX),
    imageUrl: imageUrl(doc, base),
    iconUrls: icons.icons.slice(0, MAX_ICON_URLS),
    faviconUrls: faviconCandidates(icons.favicons, finalUrl),
  };
}
