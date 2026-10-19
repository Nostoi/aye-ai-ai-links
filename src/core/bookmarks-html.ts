import { escapeHtml } from "./escape-html.js";
import type { Link, Tag } from "./types.js";

/** Chromium's importer reads one entry per line, so every line break (and tab) becomes one space. */
const oneLine = (s: string) => s.replace(/[\r\n\t\u0085\u2028\u2029]+/g, " ");
const text = (s: string) => escapeHtml(oneLine(s));
const seconds = (d: Date) => Math.floor(d.getTime() / 1000);

function entry(link: Link): string[] {
  const href = new URL(link.url);
  if (href.protocol !== "http:" && href.protocol !== "https:") {
    throw new Error("bookmarks.html only holds http and https links");
  }
  const tags = link.tags.map((t) => oneLine(t.name.replaceAll(",", "")));
  const attrs = [
    `HREF="${escapeHtml(href.href)}"`,
    `ADD_DATE="${seconds(link.savedAt)}"`,
    ...(tags.length > 0 ? [`TAGS="${escapeHtml(tags.join(","))}"`] : []),
  ];
  const title = link.title ?? link.snapshot?.title ?? link.url;
  return [
    `<DT><A ${attrs.join(" ")}>${text(title)}</A>`,
    ...(link.why ? [`<DD>${text(link.why.text)}`] : []),
  ];
}

const folder = (name: string, links: Link[]): string[] => [
  `<DT><H3>${text(name)}</H3>`,
  "<DL><p>",
  ...links.flatMap(entry),
  "</DL><p>",
];

/**
 * The Netscape bookmark format browsers import: a folder per space, then loose active
 * links, then "Done" for archived ones.
 */
export function bookmarksHtml(links: Link[], catalog: Tag[], exportedAt: Date): string {
  const active = links.filter((l) => l.state !== "archived");
  const spaces = catalog.filter((t) => t.pinned);
  const spaceKeys = new Set(spaces.map((t) => t.key));
  const lines = [
    "<!DOCTYPE NETSCAPE-Bookmark-file-1>",
    '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
    "<TITLE>Bookmarks</TITLE>",
    "<H1>Bookmarks</H1>",
    "<DL><p>",
    `<DT><H3 ADD_DATE="${seconds(exportedAt)}">Aye-AI-AI Links</H3>`,
    "<DL><p>",
    ...spaces.flatMap((s) =>
      folder(
        s.name,
        active.filter((l) => l.tags.some((t) => t.key === s.key)),
      ),
    ),
    ...active.filter((l) => !l.tags.some((t) => spaceKeys.has(t.key))).flatMap(entry),
    ...folder(
      "Done",
      links.filter((l) => l.state === "archived"),
    ),
    "</DL><p>",
    "</DL><p>",
  ];
  return `${lines.join("\n")}\n`;
}
