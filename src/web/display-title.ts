import { TITLE_MAX, titleFits } from "../core/links.js";
import type { Link } from "../core/types.js";
import { isWebUrl } from "../core/url-key.js";

/** Not blank, and not wholly a web address. */
const usable = (title: string | null | undefined): title is string => {
  const t = title?.trim() ?? "";
  return t !== "" && !/^https?:\/\/\S+$/i.test(t);
};

const decode = (segment: string) => {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
};

/** Control characters become spaces, and runs of whitespace one space. */
const plain = (text: string) => text.replace(/[\p{Cc}\s]+/gu, " ").trim();

const short = (title: string) => [...title].length <= TITLE_MAX;

const PAGE_EXTENSION = /\.(html?|php|aspx?|jsp)$/i;
const POST_SITE = /^(x|twitter)\.com$/i;

/** A title built from the address alone: `Post by @user`, or `Last words — site`, or the site. */
function fromAddress(url: string): string | null {
  if (!isWebUrl(url)) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const site = parsed.hostname.replace(/^www\./i, "");
  const [first, kind, id, ...rest] = parsed.pathname.split("/").filter(Boolean);
  if (POST_SITE.test(site) && first && first !== "i" && kind === "status" && id && !rest.length) {
    const post = `Post by @${plain(decode(first))}`;
    if (post !== "Post by @" && short(post)) return post;
  }
  const last = parsed.pathname.split("/").filter(Boolean).at(-1) ?? "";
  const words = plain(decode(last).replace(PAGE_EXTENSION, "").replace(/[-_]+/g, " "));
  const built = `${words.charAt(0).toUpperCase()}${words.slice(1)} — ${site}`;
  return /\p{L}/u.test(words) && short(built) ? built : site;
}

/**
 * What a card shows as the link's title (plain text; the caller escapes it). The stored title when
 * it is usable, else the saved page's own title when it is usable and short enough to be a title,
 * else one built from the address. The stored title is never changed. Two different addresses can
 * give the same built title; their cards still differ by picture, why and tags.
 */
export function displayTitle(link: Link): string {
  if (usable(link.title)) return link.title;
  const page = link.snapshot?.title;
  if (usable(page) && titleFits(page)) return page;
  return fromAddress(link.url) ?? link.url;
}
