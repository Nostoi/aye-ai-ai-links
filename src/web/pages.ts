import type { Link } from "../core/types.js";

const escapeHtml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] as string,
  );

/** Only web links are made clickable; anything else is shown as text. */
const isWebUrl = (url: string) => /^https?:\/\//i.test(url);

const page = (title: string, body: string) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
</head>
<body>
${body}
</body>
</html>
`;

/**
 * The sign-in form. Its script posts JSON to better-auth's own sign-in route and, when the page
 * was opened with a signed OAuth query (`sig`), passes that query on as `oauth_query`, which is
 * how better-auth resumes an authorization after login. After sign-in it goes, in order, to the
 * url better-auth returns with `redirect: true`, to `next` if that is this site's authorize path
 * (where the authorize gate sends a browser without a session), or home.
 */
export const loginPage = () =>
  page(
    "Sign in · Aye-AI-AI Links",
    `<main>
<h1>Sign in</h1>
<form id="login">
<p><label>Email <input name="email" type="email" autocomplete="username" required></label></p>
<p><label>Password <input name="password" type="password" autocomplete="current-password" required></label></p>
<p><button type="submit">Sign in</button></p>
<p id="error" role="alert"></p>
</form>
</main>
<script>
const form = document.getElementById("login");
const error = document.getElementById("error");
const afterSignIn = (query) => {
  const next = query.get("next");
  if (next === null) return "/";
  let url;
  try {
    url = new URL(next, location.origin);
  } catch {
    return "/";
  }
  const authorize = url.origin === location.origin && url.pathname === "/api/auth/oauth2/authorize";
  return authorize ? url.pathname + url.search : "/";
};
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
    location.href = resume ? data.url : afterSignIn(query);
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
<p><button id="accept" type="button">Allow</button> <button id="deny" type="button">Deny</button></p>
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
  return `<li><strong>${escapeHtml(c.name ?? c.clientId)}</strong>, connected ${c.connectedAt.toISOString().slice(0, 10)} <button type="button" data-client-id="${escapeHtml(c.clientId)}">Disconnect</button></li>`;
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
${connections.length === 0 ? "<p>No apps are connected.</p>" : `<ul>\n${connections.map(connectionItem).join("\n")}\n</ul>`}
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

function linkItem(link: Link): string {
  const label = escapeHtml(link.title ?? link.url);
  const target = isWebUrl(link.url)
    ? `<a href="${escapeHtml(link.url)}" rel="noreferrer">${label}</a>`
    : label;
  return `<li>${target}</li>`;
}

/** A placeholder home page: the owner's newest links and a sign-out button. */
export const homePage = (links: Link[]) =>
  page(
    "Aye-AI-AI Links",
    `<main>
<h1>Your newest links</h1>
${links.length === 0 ? "<p>No links saved yet.</p>" : `<ul>\n${links.map(linkItem).join("\n")}\n</ul>`}
<p><a href="/connections">Connected apps</a></p>
<p><button id="sign-out" type="button">Sign out</button></p>
</main>
<script>
document.getElementById("sign-out").addEventListener("click", async () => {
  await fetch("/api/auth/sign-out", { method: "POST" });
  location.href = "/login";
});
</script>`,
  );
