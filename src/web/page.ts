import { faviconHref, inlineLogo } from "./logo.js";
import { themeCss } from "./theme.js";

export const escapeHtml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] as string,
  );

/** "March 12"; the year is added when it is not the current one. Always read in UTC. */
export const savedOn = (savedAt: Date, now: Date) =>
  savedAt.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    ...(savedAt.getUTCFullYear() === now.getUTCFullYear() ? {} : { year: "numeric" }),
    timeZone: "UTC",
  });

const NAME = "Aye-AI-AI Links";
const brand = `${inlineLogo(`role="img" aria-label="${NAME}"`)}<span>${NAME}</span>`;

const MENU = `<nav class="menu" aria-label="Main"><a href="/connections">Apps and keys</a><button id="sign-out" type="button">Sign out</button></nav>`;

/** Ends the session, then goes to the sign-in page. */
const MENU_SCRIPT = `<script>
document.getElementById("sign-out").addEventListener("click", async () => {
  await fetch("/api/auth/sign-out", { method: "POST" });
  location.href = "/login";
});
</script>`;

/**
 * Every page renders through this. `home` links the header to `/`, for signed-in pages. `menu`
 * adds the menu (and implies `home`), for the pages the owner browses.
 */
export const page = (
  title: string,
  body: string,
  { home = false, menu = false } = {},
) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<link rel="icon" type="image/svg+xml" href="${faviconHref}">
<style>
${themeCss}
</style>
</head>
<body>
<header class="column site">${home || menu ? `<a class="brand" href="/">${brand}</a>` : `<span class="brand">${brand}</span>`}${menu ? MENU : ""}</header>
<div class="column">
${body}
</div>
${menu ? MENU_SCRIPT : ""}
</body>
</html>
`;
