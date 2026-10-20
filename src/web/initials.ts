import type { Link } from "../core/types.js";
import { hostOf } from "./host.js";

/** The first letter or digit of each of the first two words that have one, uppercased. */
export const initialsOf = (text: string) =>
  text
    .split(/\s+/)
    .map((word) => word.match(/[\p{L}\p{N}]/u)?.[0])
    .filter((c): c is string => c !== undefined)
    .slice(0, 2)
    .join("")
    .toUpperCase();

/** What a picture-less card shows, on `--pic`: the title's initials, else the host's. */
export function initialsText(link: Link): string {
  const host = hostOf(link.url).replace(/^www\./, "");
  return initialsOf(link.title ?? "") || initialsOf(host.replaceAll(".", " "));
}
