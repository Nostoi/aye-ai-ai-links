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
 * how better-auth resumes an authorization after login.
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
    location.href = "/";
  } else {
    error.textContent = res.status === 429
      ? "Too many sign-in attempts. Wait a few minutes and try again."
      : "That email and password did not match.";
  }
});
</script>`,
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
<p><button id="sign-out" type="button">Sign out</button></p>
</main>
<script>
document.getElementById("sign-out").addEventListener("click", async () => {
  await fetch("/api/auth/sign-out", { method: "POST" });
  location.href = "/login";
});
</script>`,
  );
