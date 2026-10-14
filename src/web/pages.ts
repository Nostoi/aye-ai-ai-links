import type { Link } from "../core/types.js";
import { faviconHref, inlineLogo } from "./logo.js";
import { themeCss } from "./theme.js";

const escapeHtml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] as string,
  );

/** Only web links are made clickable; anything else is shown as text. */
const isWebUrl = (url: string) => /^https?:\/\//i.test(url);

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
const page = (title: string, body: string, { home = false, menu = false } = {}) => `<!doctype html>
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

/**
 * The sign-in form. Its script posts JSON to better-auth's own sign-in route and, when the page
 * was opened with a signed OAuth query (`sig`), passes that query on as `oauth_query`, which is
 * how better-auth resumes an authorization after login. After sign-in it goes, in order, to the
 * url better-auth returns with `redirect: true`, or to `next`, the already-checked page the door
 * passes in (`returnAfterLogin`: this site's authorize path, or home), held in `data-next`.
 */
export const loginPage = ({ next }: { next: string }) =>
  page(
    "Sign in · Aye-AI-AI Links",
    `<main class="card card-narrow">
<h1>Sign in</h1>
<form id="login" data-next="${escapeHtml(next)}">
<p><label>Email <input name="email" type="email" autocomplete="username" required></label></p>
<p><label>Password <input name="password" type="password" autocomplete="current-password" required></label></p>
<p><button class="primary" type="submit">Sign in</button></p>
<p id="error" role="alert"></p>
</form>
</main>
<script>
const form = document.getElementById("login");
const error = document.getElementById("error");
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  error.textContent = "";
  const body = { email: form.email.value, password: form.password.value };
  const query = new URLSearchParams(location.search);
  if (query.has("sig")) body.oauth_query = query.toString();
  const res = await fetch("/api/auth/sign-in/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.ok) {
    const data = await res.json().catch(() => null);
    const resume = data !== null && data.redirect === true && typeof data.url === "string";
    location.href = resume ? data.url : form.dataset.next;
  } else {
    error.textContent = res.status === 429
      ? "Too many sign-in attempts. Wait a few minutes and try again."
      : "That email and password did not match.";
  }
});
</script>`,
  );

/**
 * Asks the owner to approve a new connection. Its buttons post `{accept, oauth_query}` (the
 * page's own signed query) to better-auth's consent route, then follow the url it returns: the
 * client's redirect, carrying a code or `access_denied`.
 */
export const consentPage = ({
  clientName,
  redirectHost,
}: {
  clientName: string;
  redirectHost: string;
}) =>
  page(
    "Approve a connection · Aye-AI-AI Links",
    `<main>
<h1>Connect ${escapeHtml(clientName)}?</h1>
<p><strong>${escapeHtml(clientName)}</strong> asks to read and save links in your library. If you allow it, you are sent back to <strong>${escapeHtml(redirectHost)}</strong>.</p>
<p class="actions"><button class="primary" id="accept" type="button">Allow</button> <button id="deny" type="button">Deny</button></p>
<p id="error" role="alert"></p>
</main>
<script>
const error = document.getElementById("error");
const answer = async (accept) => {
  error.textContent = "";
  const res = await fetch("/api/auth/oauth2/consent", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ accept, oauth_query: location.search.slice(1) }),
  });
  const data = await res.json().catch(() => null);
  if (res.ok && data !== null && typeof data.url === "string") {
    location.href = data.url;
  } else {
    error.textContent = "That did not work. The request may have expired: start the connection again from the app.";
  }
};
document.getElementById("accept").addEventListener("click", () => answer(true));
document.getElementById("deny").addEventListener("click", () => answer(false));
</script>`,
    { home: true },
  );

/** Shown when the consent page's signed query is missing, tampered with or expired. */
export const consentExpiredPage = () =>
  page(
    "Approval expired · Aye-AI-AI Links",
    `<main>
<h1>This approval link is not valid</h1>
<p>It may have expired. Start the connection again from the app.</p>
</main>`,
  );

export type ConnectionRow = { clientId: string; name: string | null; connectedAt: Date };

function connectionItem(c: ConnectionRow): string {
  return `<li><span><strong>${escapeHtml(c.name ?? c.clientId)}</strong>, connected ${c.connectedAt.toISOString().slice(0, 10)}</span> <button type="button" data-client-id="${escapeHtml(c.clientId)}">Disconnect</button></li>`;
}

/**
 * The owner's connected apps. Each Disconnect button posts `{clientId}` (read from its data
 * attribute, never written into the script) to `/connections/disconnect`, then reloads.
 */
export const connectionsPage = (connections: ConnectionRow[]) =>
  page(
    "Connected apps · Aye-AI-AI Links",
    `<main>
<h1>Connected apps</h1>
${connections.length === 0 ? "<p>No apps are connected.</p>" : `<ul class="connections">\n${connections.map(connectionItem).join("\n")}\n</ul>`}
<p>A disconnected app is refused from its next request. To use it again, connect it again from the app.</p>
<p id="error" role="alert"></p>
<p><a href="/">Back to your links</a></p>
</main>
<script>
const error = document.getElementById("error");
for (const button of document.querySelectorAll("button[data-client-id]")) {
  button.addEventListener("click", async () => {
    error.textContent = "";
    const res = await fetch("/connections/disconnect", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientId: button.dataset.clientId }),
    });
    if (res.ok) location.reload();
    else error.textContent = "That did not work. Reload the page and try again.";
  });
}
</script>`,
    { menu: true },
  );

/** Where an OAuth authorization that failed ends. `message` is always one of our own sentences. */
export const oauthErrorPage = (message: string) =>
  page(
    "Connection failed · Aye-AI-AI Links",
    `<main>
<h1>This connection did not work</h1>
<p>${escapeHtml(message)}</p>
</main>`,
  );

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
};

/** "March 12"; the year is added when it is not the current one. Always read in UTC. */
const savedOn = (savedAt: Date, now: Date) =>
  savedAt.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    ...(savedAt.getUTCFullYear() === now.getUTCFullYear() ? {} : { year: "numeric" }),
    timeZone: "UTC",
  });

function whyLine(why: Link["why"]): string {
  if (!why) return "No why yet";
  const text = escapeHtml(why.text);
  return why.source === "inferred" ? `Why (a guess): ${text}` : `Why: "${text}"`;
}

function resultItem(link: Link, now: Date): string {
  const label = escapeHtml(link.title ?? link.url);
  const title = isWebUrl(link.url)
    ? `<a href="${escapeHtml(link.url)}" target="_blank" rel="noopener noreferrer">${label}</a>`
    : label;
  const host = hostOf(link.url);
  const saved = `${host ? `${escapeHtml(host)}, saved` : "Saved"} ${savedOn(link.savedAt, now)}`;
  return `<li class="result">
<div class="tile" aria-hidden="true"></div>
<div class="result-body">
<h2>${title}</h2>
<p class="small">${saved}</p>
${link.summary ? `<p>${escapeHtml(link.summary)}</p>\n` : ""}<p class="small">${whyLine(link.why)}</p>
</div>
</li>`;
}

/** The big question and one search field; the script lets `/` jump to it unless the owner is typing. */
export const homePage = () =>
  page(
    "Aye-AI-AI Links",
    `<main class="home">
<form action="/search" method="get" role="search">
<label class="question" for="q">What are you trying to remember?</label>
<div class="search-box">
<input id="q" name="q" type="search" placeholder="That article about batteries and the tax credit">
<kbd aria-hidden="true">/</kbd>
<button class="primary" type="submit">Find it</button>
</div>
<p class="small hint">Describe it however you remember it: when, why, what it looked like.</p>
</form>
</main>
<script>
document.addEventListener("keydown", (event) => {
  if (event.key !== "/") return;
  const active = document.activeElement;
  if (active && (active.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(active.tagName))) return;
  event.preventDefault();
  document.getElementById("q").focus();
});
</script>`,
    { menu: true },
  );

/** Search results, as the door got them. A blank query lists the newest links, so it is headed so. */
export const searchPage = ({ query, links, now }: { query: string; links: Link[]; now: Date }) =>
  page(
    "Search · Aye-AI-AI Links",
    `<main>
<form action="/search" method="get" role="search">
<label class="visually-hidden" for="q">Search your links</label>
<div class="search-box">
<input id="q" name="q" type="search" value="${escapeHtml(query)}">
<button class="primary" type="submit">Find it</button>
</div>
</form>
<h1>${query.trim() === "" ? "Your newest links" : "Best matches first"}</h1>
${links.length === 0 ? `<p>${query.trim() === "" ? "No links saved yet." : "Nothing matched."}</p>` : `<ol class="results">\n${links.map((l) => resultItem(l, now)).join("\n")}\n</ol>`}
<div class="not-it">
<p><strong>Not it?</strong></p>
<p class="small">Try different words: what it was about, why you saved it, or roughly when. Or see <a href="/search?q=">your newest links</a>.</p>
</div>
</main>`,
    { menu: true },
  );
