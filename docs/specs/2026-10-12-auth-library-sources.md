# Auth library: decisions and their sources

Dated 2026-10-12, for #75. This is a dated record: it is not updated, and a later decision supersedes it in `ROADMAP.md`. The owner's rulings are in #11 comment 6134986546 and #75 comment 6136036644; #75 comment 6136212307 lists the review's refinements.

## Decision

Phase 3 uses **better-auth 1.7.7**, pinned exactly, with:

- `@better-auth/mcp` for the OAuth server and `/mcp` resource metadata;
- `@better-auth/cimd` for client ID metadata documents;
- `@better-auth/oauth-provider`, which both of the above depend on.

The app adds the conditions below. The fallback, panva `oidc-provider`, was not needed.

## How it was tested

A throwaway spike ran outside the repository. It used the app's Hono 4.13.13 and better-sqlite3 13.0.3 and drove every request in-process through `app.fetch()`. A network guard confirmed nothing left the process.

- The first run passed 71 checks. The follow-up run, for Codex's challenge, passed 26 more. Faults and race windows were injected deterministically by patching adapter methods.
- Every claim below was observed in those runs, or read in the installed package source where marked READ.
- The spike code is not kept. #77 turns the checks that guard the conditions below into the app's tests.

## What it showed

**Fits the app**
- better-auth takes a better-sqlite3 handle directly and mounts on Hono.
- Its 12 tables (`user`, `session`, `account`, `verification`, `jwks`, and the `oauth*` tables) do not clash with the app's.
- Its migrations run from code (`getMigrations` from `better-auth/db/migration`), and it never touches `PRAGMA user_version`.

**Closed sign-up, owner `owner`**
- With `emailAndPassword.disableSignUp: true`, `POST /sign-up/email` returns 400 `EMAIL_PASSWORD_SIGN_UP_DISABLED`. With sign-up open, the same request creates a user.
- No other route mounted in this setup creates a user, as long as no social provider is configured (READ).
- `auth.$context.internalAdapter.createUser({ id: "owner", … })` keeps the given id, so a token's `sub` is `owner`. A second owner works the same way.

**What ChatGPT and Claude require** (their requirements are summarized in #11 comment 6134986546)
- RFC 9728 metadata whose `resource` is byte-exact, and a 401 with `WWW-Authenticate: Bearer resource_metadata="…"`.
- RFC 8414 metadata advertising:
  - `client_id_metadata_document_supported`;
  - `none` client authentication;
  - S256 only;
  - `authorization_response_iss_parameter_supported`.
- CIMD and the DCR fallback both work, with redirect URIs for ChatGPT and Claude.
- These were refused:
  - plain or missing PKCE;
  - a reused code;
  - an unregistered redirect URI;
  - a wrong `resource`, or one with a trailing slash.
- Codex also ran ChatGPT's current signed client metadata (`private_key_jwt`). It completed the flow, and the document is 544 bytes. Whether Claude's document fits the 5 KB cap is not checked; #77 checks it.

**Revocation**
- JWT access tokens cannot be revoked before they expire. Revoking the refresh token, deleting the consent and signing out each left `/mcp` accepting the token.
- Opaque access tokens (`disableJwtPlugin: true`) become inactive on the next introspection after revocation. That matches agent keys, which `keyIdentify` looks up on every request.
- Deleting a consent revokes nothing.

**Codex challenge** (REVISE). Codex reproduced three ways a revoked app keeps a working token, and the spike confirmed each:
1. A rotation paused after it marks the old refresh token used, while a replay of an earlier token invalidates the family. The rotation then still creates a live refresh token and access token.
2. A disconnect that deletes tokens and consent leaves an unused authorization code that still exchanges for an active token. Codes are `verification` rows whose JSON `value` holds the type, `client_id` and `userId`.
3. If deleting the refresh-token family fails during a replay, the replay returns 500 and the successor refresh token still works. This is better-auth issue #11629, open on 1.7.7.

Codex also found that a token with only the `offline_access` scope is active for `/mcp`.

## Conditions

1. **Opaque access tokens.** `/mcp` introspects each one in-process (`auth.api.oauth2Introspect`), which needs an internal confidential client.
2. **A separate SQLite file for auth.**
   - A deliberate await inside a better-auth transaction rolled back app writes on a shared handle.
   - On a second connection to the same file, it gave `SQLITE_BUSY`.
   - No real flow kept a transaction open across an await, so a shared file is a latent risk.
   - `deploy.sh` must back up and roll back this file too. Its current restore check compares `user_version`, which better-auth never sets, so the auth file needs its own way to tell that a restore is needed.
3. **One lock in the server process.** Every `/api/auth/*` request goes through it, and so does every server-side `auth.api` call that writes tokens, codes or consent.
   - It fixes case 1: with the lock, the replay waits, and afterwards the whole family is dead. Eight concurrent flows and eight concurrent refreshes all completed.
   - In the spike the lock was Hono middleware on the request path, so `auth.api` calls skipped it.
   - It relies on a single process. A CLI command never writes tokens, codes or consent; to do that it asks the running server. The CLI may create owners (user and account rows), which writes none of these.
   - No unauthenticated request may hold the lock while it waits on the network. In the spike, an authorize, token or revoke request naming an unknown CIMD `client_id` held it for up to 5 s while the document was fetched. #77 chooses how to prevent this.
4. **Disconnect is one transaction under that lock, run inside the server.**
   - For one client and owner, it deletes the `oauthAccessToken`, `oauthRefreshToken` and `oauthConsent` rows, and the `verification` rows holding that pair's authorization codes. This fixes case 2.
   - It writes into better-auth's tables directly, so its tests re-run on every upgrade.
5. **Case 3 is an accepted residual risk** (owner ruling, #75 comment 6136036644).
   - It needs a SQLite write to fail mid-request.
   - Wrapping each token request in an outer transaction, with better-auth's own transactions off, made the failure roll back as a unit. But the current access token still stayed active until a later replay. With better-auth's own transactions on, the outer transaction errors ("cannot start a transaction within a transaction").
   - It is watched through #11629.
6. **`/mcp` requires the `links` scope.**
7. **Refresh-token reuse window of 0.** `mcp()` defaults to 30 s, and within that window a replay gets a 200 with the same response.
8. **`mcp()` together with `cimd()`, and never also `oauthProvider()`.** Registering both logs 29 path conflicts and starts anyway.
9. **CIMD documents are fetched through a new JSON fetcher built on `isPublicAddress`.**
   - **Addresses.** A hostname connects through the page fetcher's `guardedLookup`, so the address that passed the check is the one it connects to. An IP-literal host never reaches a lookup, so it is checked with `isPublicAddress` before connecting, as the page fetcher's `refusalFor` does. cimd requires the transport to "resolve the hostname exactly once … pin the approved address for the connection, and refuse redirects" (READ `@better-auth/cimd/dist/index.d.mts`). better-auth refuses only private hosts written as literal addresses (READ), so for hostnames this fetcher is the only defence.
   - **Limits.** It refuses redirects and has a 5 s limit.
   - **Size.** It also serves `jwks_uri`. better-auth allows a key set up to 64 KiB (`MAX_JWKS_RESPONSE_BYTES`, READ), and cimd enforces its own 5 KB cap on metadata documents, so the fetcher's cap is 64 KiB. #77 checks the size of ChatGPT's key set.
   - **Revalidation.** It forwards cimd's request headers (`If-None-Match`, `If-Modified-Since`) and returns a 304 unchanged. Introspection re-fetches a document once cimd's cached copy goes stale, and a failed re-fetch makes the token inactive (READ). How long a copy stays fresh depends on the document's own caching headers, so #77 checks the real Claude and ChatGPT documents' headers.
   - **Fetch budget.** Unauthenticated requests must not be able to use up the fetch budget that the owner's connected clients need to revalidate. In a review probe, 30 requests a minute naming junk `client_id`s on claude.ai's origin made the owner's Claude token inactive while its document was stale. cimd spends budget before it validates the URL (READ). #77 chooses how to prevent this.
   - **Reuse.** The page fetcher returns `not_html` for JSON, so it can't be reused as it is.
10. **`savedBy` is the client's registered name, falling back to its `client_id`.** Introspection returns no client name. A CIMD `client_id` is its stable URL; DCR issues a new one on each registration.

## Security record

- **Advisories.** On 2026-10-12, better-auth listed 27 advisories published since 2026-04. All but one affect only versions below 1.7.7. GHSA-fmh4-wcc4-5jm3 lists `>= 1.6.14` with no patched version; it is in the organization plugin, which this setup does not use.
- **Open token bugs.**
  - #11629: covered by condition 5.
  - #11595: some malformed tokens get 500 instead of 401.
  - #11702: the revocation response does not follow RFC 7009.
  - #11553: in the older `better-auth/plugins` `mcp` at 1.6.33, not in the standalone `@better-auth/mcp` used here.

## Rejected alternatives

- **JWT access tokens with a short lifetime.** Revocation would lag by that lifetime (owner choice).
- **Panva `oidc-provider` first.** We would write the storage adapter, login and consent ourselves, and no blocker was found that needed it (owner choice).
- **A shared database file.** The rollback hazard is latent, and the separate file costs only a by-value owner id link.
