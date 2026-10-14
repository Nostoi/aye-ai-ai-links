import type { Link } from "../core/types.js";
import { escapeHtml, page, savedOn } from "./page.js";

/** Only web links are made clickable; anything else is shown as text. */
export const isWebUrl = (url: string) => /^https?:\/\//i.test(url);

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
<p><strong>${escapeHtml(clientName)}</strong> asks to read and save links in your library. If you allow it, you are sent back to <strong>${escapeHtml(redirectHost)}</strong>. It stays connected while you use it, until you disconnect it on the Apps and keys page.</p>
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

function whyLine(why: Link["why"]): string {
  if (!why) return "No why yet";
  const text = escapeHtml(why.text);
  return why.source === "inferred" ? `Why (a guess): ${text}` : `Why: "${text}"`;
}

/**
 * The link's stored image, served by this site, or the plain tile; never the page's own image URL.
 * `className` styles both.
 */
export const tile = (link: Link, version: string | undefined, className = "tile") =>
  version === undefined
    ? `<div class="${className}" aria-hidden="true"></div>`
    : `<img class="${className}" src="/images/${encodeURIComponent(link.id)}?v=${encodeURIComponent(version)}" alt="" loading="lazy">`;

function resultItem(link: Link, now: Date, version: string | undefined): string {
  const label = escapeHtml(link.title ?? link.url);
  const title = isWebUrl(link.url)
    ? `<a href="${escapeHtml(link.url)}" target="_blank" rel="noopener noreferrer">${label}</a>`
    : label;
  const host = hostOf(link.url);
  const saved = `${host ? `${escapeHtml(host)}, saved` : "Saved"} ${savedOn(link.savedAt, now)}`;
  return `<li class="result">
${tile(link, version)}
<div class="result-body">
<h2>${title}</h2>
<p class="small">${saved}</p>
${link.summary ? `<p>${escapeHtml(link.summary)}</p>\n` : ""}<p class="small">${whyLine(link.why)}</p>
</div>
</li>`;
}

/**
 * Search results, as the door got them. A blank query lists the newest links, so it is headed so.
 * `images` holds the image version of each link that has a stored image.
 */
export const searchPage = ({
  query,
  links,
  now,
  images = new Map(),
}: {
  query: string;
  links: Link[];
  now: Date;
  images?: Map<string, string>;
}) =>
  page(
    "Search · Aye-AI-AI Links",
    `<main>
<form class="search-page" action="/search" method="get" role="search">
<label class="visually-hidden" for="q">Search your links</label>
<div class="search-box">
<input id="q" name="q" type="search" value="${escapeHtml(query)}">
<button class="primary" type="submit">Find it</button>
</div>
</form>
<h1>${query.trim() === "" ? "Your newest links" : "Best matches first"}</h1>
${links.length === 0 ? `<p>${query.trim() === "" ? "No links saved yet." : "Nothing matched."}</p>` : `<ol class="results">\n${links.map((l) => resultItem(l, now, images.get(l.id))).join("\n")}\n</ol>`}
<div class="not-it">
<p><strong>Not it?</strong></p>
<p class="small">Try different words: what it was about, why you saved it, or roughly when. Or see <a href="/search?q=">your newest links</a>.</p>
</div>
</main>`,
    { menu: true },
  );
