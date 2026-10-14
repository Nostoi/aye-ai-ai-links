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

const MENU = `<nav class="menu" aria-label="Main"><a href="/all">All links</a><a href="/tags">Tags</a><a href="/profile">Profile</a><a href="/connections">Apps and keys</a><button id="sign-out" type="button">Sign out</button></nav>`;

/** Ends the session, then goes to the sign-in page. */
const MENU_SCRIPT = `<script>
document.getElementById("sign-out").addEventListener("click", async () => {
  await fetch("/api/auth/sign-out", { method: "POST" });
  location.href = "/login";
});
</script>`;

/** Idle and maximum times the Undo bar stays up; the maximum is below `UNDO_WINDOW_MS` and `NOTE_UNDO_WINDOW_MS`. */
export const UNDO_BAR_MS = 10_000;
export const UNDO_BAR_MAX_MS = 45_000;

const UNDO_BAR = `<div role="status"><div class="undo-bar" id="undo-bar" hidden><span></span><button type="button">Undo</button></div></div>`;

/**
 * Defines `showUndo(message, undo)` for the page's own script, which calls it after an action has
 * already been done. The bar shows `message` and moves focus to its Undo button. It closes
 * `UNDO_BAR_MS` after it last had neither focus nor the pointer.
 * Undo runs `undo` once, with the button disabled until it settles, then closes the
 * bar. A new message replaces the bar, and a pending undo only closes the bar if it is still its
 * own. When the bar closes with focus on it, focus goes back to what had it before,
 * if that is still on the page.
 */
const UNDO_SCRIPT = `<script>
const showUndo = (() => {
  const bar = document.getElementById("undo-bar");
  const text = bar.querySelector("span");
  const button = bar.querySelector("button");
  let current = null;
  let focused = false;
  let hovered = false;
  let returnTo = null;
  const arm = (action) => {
    clearTimeout(action.timer);
    if (!focused && !hovered) action.timer = setTimeout(() => close(action), ${UNDO_BAR_MS});
  };
  const pause = () => {
    if (current) clearTimeout(current.timer);
  };
  const resume = () => {
    if (current && !current.running) arm(current);
  };
  // \`held\`: the bar had focus when Undo was clicked; disabling the button may have dropped it
  // to the body since.
  const close = (action, held = false) => {
    if (current !== action) return;
    clearTimeout(action.timer);
    clearTimeout(action.ceiling);
    current = null;
    const now = document.activeElement;
    const hadFocus = bar.contains(now) || (held && (!now || now === document.body));
    bar.hidden = true;
    focused = false;
    hovered = false;
    if (hadFocus && returnTo && returnTo.isConnected) returnTo.focus();
    returnTo = null;
  };
  bar.addEventListener("focusin", () => {
    focused = true;
    pause();
  });
  bar.addEventListener("focusout", (event) => {
    if (bar.contains(event.relatedTarget)) return;
    focused = false;
    resume();
  });
  bar.addEventListener("mouseenter", () => {
    hovered = true;
    pause();
  });
  bar.addEventListener("mouseleave", () => {
    hovered = false;
    resume();
  });
  button.addEventListener("click", async () => {
    const action = current;
    if (!action || action.running) return;
    action.running = true;
    clearTimeout(action.timer);
    clearTimeout(action.ceiling);
    const held = bar.contains(document.activeElement);
    button.disabled = true;
    try {
      await action.undo();
    } finally {
      if (current === action) button.disabled = false;
      close(action, held);
    }
  });
  return (message, undo) => {
    if (current) {
      clearTimeout(current.timer);
      clearTimeout(current.ceiling);
    }
    if (!current || !bar.contains(document.activeElement)) returnTo = document.activeElement;
    const action = { undo, running: false };
    action.ceiling = setTimeout(() => close(action), ${UNDO_BAR_MAX_MS});
    current = action;
    text.textContent = message;
    button.disabled = false;
    bar.hidden = false;
    arm(action);
    button.focus();
  };
})();
</script>`;

/**
 * Every page renders through this. `home` links the header to `/`, for signed-in pages. `menu`
 * adds the menu (and implies `home`), for the pages the owner browses. `undo` adds the Undo bar
 * and `showUndo`.
 */
export const page = (
  title: string,
  body: string,
  { home = false, menu = false, undo = false } = {},
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
${undo ? `${UNDO_BAR}\n${UNDO_SCRIPT}\n` : ""}${menu ? MENU_SCRIPT : ""}
</body>
</html>
`;
