/**
 * Sites whose preview images are pictures of words: GitHub's social cards and X's link cards
 * (#193). Their links show the site's icon instead. Only these hosts and their `www.` form.
 */
const WORD_PICTURE_HOSTS = ["github.com", "x.com", "twitter.com"];

/** Whether a link's saved address is on a word-picture host. */
export function isWordPictureHost(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }
  return WORD_PICTURE_HOSTS.includes(host.replace(/^www\./, ""));
}

/** The preview to keep for a page saved at `url`: the one it names, except on a word-picture host. */
export const keptPreview = (url: string, imageUrl: string | null): string | null =>
  isWordPictureHost(url) ? null : imageUrl;
