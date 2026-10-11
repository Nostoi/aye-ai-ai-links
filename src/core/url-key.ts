import { CoreError } from "./errors.js";

const TRACKING = new Set([
  "fbclid",
  "gclid",
  "dclid",
  "gbraid",
  "wbraid",
  "msclkid",
  "mc_cid",
  "mc_eid",
  "igshid",
  "yclid",
  "_ga",
  "_gl",
]);

function isTracking(segment: string): boolean {
  let name = segment.split("=")[0] ?? "";
  try {
    name = decodeURIComponent(name);
  } catch {
    // keep the raw name
  }
  name = name.toLowerCase();
  return name.startsWith("utm_") || TRACKING.has(name);
}

/** Practical duplicate key: same page, ignoring tracking params, fragments and trailing slashes. */
export function urlKey(raw: string): string {
  const trimmed = raw.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new CoreError(
      "invalid_url",
      `"${trimmed}" is not a valid URL. Pass a full address such as https://example.com/page.`,
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new CoreError(
      "invalid_url",
      `Only http and https links can be saved, not ${url.protocol}. Use the page's web address.`,
    );
  }
  if (url.username !== "" || url.password !== "") {
    throw new CoreError(
      "invalid_url",
      "The URL contains a username or password. Remove the credentials and save the plain address.",
    );
  }
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const kept = url.search
    .slice(1)
    .split("&")
    .filter((s) => s !== "" && !isTracking(s));
  const query = kept.length > 0 ? `?${kept.join("&")}` : "";
  const keepHash = url.hash.startsWith("#/") || url.hash.startsWith("#!");
  return `${url.protocol}//${url.host}${path}${query}${keepHash ? url.hash : ""}`;
}
