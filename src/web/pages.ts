import type { PictureInfo } from "../core/image-store.js";
import type { GoneView } from "../core/link-check.js";
import { linkSpace, type Space } from "../core/link-space.js";
import type { CopyInfo } from "../core/saved-copy.js";
import type { HandyView } from "../core/tools.js";
import type { Link, Tag } from "../core/types.js";
import { removeCopyScript } from "./copy-menu.js";
import { editData, editDialog, editLinkScript, editMenu } from "./edit-link.js";
import { goneLine, goneScript } from "./gone-line.js";
import { hostOf } from "./host.js";
import { handyControl, keepHandyScript } from "./keep-handy.js";
import { linkTitle, openedScript } from "./open-link.js";
import { escapeHtml, page, savedOn } from "./page.js";
import { CARD_FETCH } from "./tell-why.js";

/**
 * The sign-in form. Its script posts JSON to better-auth's own sign-in route and, when the page
 * was opened with a signed OAuth query (`sig`), passes that query on as `oauth_query`, which is
 * how better-auth resumes an authorization after login. After sign-in it goes, in order, to the
 * url better-auth returns with `redirect: true`, or to `next`, the already-checked page the door
 * passes in (`returnAfterLogin`: this site's authorize path, the rebuilt `/save`, or home), held in `data-next`.
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

/** The why as every link card reads it; an inferred one is a guess. */
export function whyLine(why: Link["why"]): string {
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

/** The ` space-<color>` class of a space, or nothing for neutral. */
export const spaceClass = (space: Pick<Space, "color"> | null) =>
  space ? ` space-${space.color}` : "";

/** A card's space (its color dot and name) and site, as All links and the Handy shelf show them. */
export function siteLine(link: Link, space: Space | null): string {
  const site = [space?.name, hostOf(link.url)].filter(Boolean).join(", ");
  const dot = space ? `<span class="dot" aria-hidden="true"></span>` : "";
  return site ? `<p class="card-site">${dot}${escapeHtml(site)}</p>\n` : "";
}

/** A space's name after its color dot, as a card names the space it is in. */
const spaceName = (space: Space | null) =>
  space
    ? `<span class="in-space"><span class="dot" aria-hidden="true"></span>${escapeHtml(space.name)}</span> `
    : "";

function resultItem(
  link: Link,
  now: Date,
  version: string | undefined,
  space: Space | null,
  view: HandyView | null | undefined,
  gone: GoneView | null | undefined,
  info: PictureInfo | undefined,
  copy: CopyInfo | undefined,
): string {
  const host = hostOf(link.url);
  const saved = `${host ? `${escapeHtml(host)}, saved` : "Saved"} ${savedOn(link.savedAt, now)}`;
  return `<li class="result${spaceClass(space)}" data-id="${escapeHtml(link.id)}"${editData(link, version, info)}>
${tile(link, version)}
<div class="result-body">
${editMenu(link, copy)}
<h2>${linkTitle(link)}</h2>
<p class="small">${saved}</p>
${link.summary ? `<p>${escapeHtml(link.summary)}</p>\n` : ""}<p class="small">${spaceName(space)}${whyLine(link.why)}</p>
${goneLine(link, gone, copy)}${handyControl(link, view)}</div>
</li>`;
}

/**
 * Search results, as the door got them. A blank query lists the newest links, so it is headed so.
 * `images` holds the image version of each link that has a stored image; `catalog`, the owner's
 * tags, gives each card its space (`linkSpace`). `keep` is the mode the Handy shelf's Add opens: it
 * asks for a link to keep handy and carries itself through a search typed here. `pictures` holds
 * each card's picture info for the edit dialog; `copies` holds the links that have a saved copy.
 */
export const searchPage = ({
  query,
  links,
  now,
  images = new Map(),
  catalog = [],
  handy = new Map(),
  gone = new Map(),
  keep = false,
  pictures = new Map(),
  copies = new Map(),
}: {
  query: string;
  links: Link[];
  now: Date;
  images?: Map<string, string>;
  catalog?: Tag[];
  handy?: Map<string, HandyView | null>;
  gone?: Map<string, GoneView | null>;
  keep?: boolean;
  pictures?: Map<string, PictureInfo>;
  copies?: Map<string, CopyInfo>;
}) =>
  page(
    "Search · Aye-AI-AI Links",
    `<main>
<form class="search-page" action="/search" method="get" role="search">
<label class="visually-hidden" for="q">Search your links</label>
<div class="search-box">
<input id="q" name="q" type="search" value="${escapeHtml(query)}"${keep ? " autofocus" : ""}>
<button class="primary" type="submit">Find it</button>
</div>
${keep ? `<input type="hidden" name="keep" value="1">\n` : ""}</form>
<h1>${query.trim() !== "" ? "Best matches first" : keep ? "Find the link to keep handy" : "Your newest links"}</h1>
${keep ? `<p class="small hint">Find the link you use regularly, then press <strong>Keep handy</strong>.</p>\n` : ""}
<p id="results-error" role="alert"></p>
${links.length === 0 ? `<p>${query.trim() !== "" ? "Nothing matched." : keep ? "No active links to keep handy." : "No links saved yet."}</p>` : `<ol class="results" id="results">\n${links.map((l) => resultItem(l, now, images.get(l.id), linkSpace(l, catalog), handy.get(l.id), gone.get(l.id), pictures.get(l.id), copies.get(l.id))).join("\n")}\n</ol>`}
<div class="not-it">
<p><strong>Not it?</strong></p>
<p class="small">Try different words: what it was about, why you saved it, or roughly when. Or see <a href="/search?q=${keep ? "&keep=1" : ""}">your newest links</a>.</p>
</div>
</main>
${editDialog()}
<script>
${CARD_FETCH}
${keepHandyScript("results", "results-error")}
${goneScript("results", "results-error")}
${removeCopyScript("results", "results-error")}
${editLinkScript("results", "results-error")}
</script>
${openedScript("results", "/links/opened")}`,
    { menu: true, undo: true },
  );
