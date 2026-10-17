# Bookmarklet: save the current page: design (2026-10-17)

Issue #129. Owner rulings are from the 2026-10-17 session, recorded in #129 comment 6241001472; they are binding and are marked **(ruling)** below. Everything else is a design choice made here, and choices that rest on something not yet checked are marked **Assumption**. Three questions the rulings left open (Q1 to Q3) were settled by the controller on 2026-10-17; the sections they affect say so. This is a dated design record; later ROADMAP.md entries override it.

## Goal

Save the page the owner is reading, from the browser, without opening an AI:
- one tap on a bookmark opens our Save page with the page's address and title filled in;
- an optional why, in the owner's own words;
- one tap on Save saves it, then shows "Saved" with Close **(ruling)**.

The Save page has a stable address, `/save?url=&title=`, so a phone Shortcut can open it later **(ruling)**.

## Not in scope

- **The phone share sheet** (an iOS Shortcut or an app). It comes later; this design only gives it the stable address **(ruling)**. Design spec §2 (line 50) routes a future share sheet through the JSON API in `api/`; the ruling replaces that with the Save page, and the ROADMAP entry for this work says so.
- **Using selected text as the why** **(ruling)**. The bookmarklet never reads the selection.
- **Tags, summary or Keep handy** from the Save page. An AI can add them later with `update_link`.
- **A JSON API.** No `api/` door is created.
- **A per-link page** on the site (see §3, "What the page shows").

## 1. The bookmarklet

### What it reads and opens

The code reads two things from the page it runs on, and nothing else: `location.href` and `document.title`. It opens one URL in a new tab:

```
<base>/save?url=<encodeURIComponent(href)>&title=<encodeURIComponent(title)>
```

- `<base>` is the server's configured public origin, `AYE_BASE_URL` (`auth.options.baseURL`, read in `src/app.ts`), never the request's host. The Save POST passes the origin check only on that origin (`originRefused` compares against `new URL(baseUrl).origin`, `src/auth/http.ts`), so a bookmarklet built from the tailnet host would fail at Save.
- **The title is cut to 200 characters** **(ruling)**, counted as core counts them: trimmed first, then cut to 200 code points, `Array.from(document.title.trim()).slice(0, 200).join("")`. A plain `.slice(0, 200)` counts UTF-16 units and can split an emoji, and core refuses more than 200 code points after trimming (`normalizeTitle`, `TITLE_MAX` in `src/core/links.ts`).
- **The address is never cut**, since a cut address is a different page. When the encoded address is longer than **4,000 characters**, the bookmarklet opens `<base>/save?long=1` instead, and the Save page says "This page's address is too long to save from the bookmarklet." (limits below).

The code is one `javascript:` URL that ends by evaluating to `undefined`, so the browser does not replace the host page with its result. It contains no `%` character, since a browser decodes `%` sequences in a bookmark's address. It is built by one function, `bookmarkletCode(base)`, in a new `src/web/bookmarklet.ts`, which both the install section and the tests use. The shape (spacing aside):

```js
javascript:(()=>{const u=encodeURIComponent(location.href);const t=encodeURIComponent(Array.from(document.title.trim()).slice(0,200).join(""));window.open(BASE+(u.length>4000?"/save?long=1":"/save?url="+u+"&title="+t),"_blank","noopener");})()
```

`BASE` is the origin as a JSON string literal, written in by `bookmarkletCode`.

### No injection into the host page

A bookmarklet necessarily runs inside the host page's JavaScript. It must:
- add, change or remove nothing in the host page's document, and load no script, style or frame into it;
- send nothing from the host page itself: no `fetch`, no form post, no image beacon;
- open our page with `noopener`, so neither page gets a handle on the other.

**Threat model.** Because the code runs in the host's realm, a hostile host can change what it reads, for example by replacing `window.open` or `document.title`. The protection is not in the bookmarklet: nothing is saved until the owner taps Save on our own origin, the Save page shows the address it will save (with its host shown plainly), and the POST is origin-checked. A host that opens `/save?url=…` itself, without the bookmarklet, gets the same: a filled form and no write.

**Assumption:** the host page's Content-Security-Policy does not block a bookmarklet in current Chrome, Safari and Firefox. Not checked here; the implementation PR checks it on a site with a strict CSP in each browser and records the result.

### Length limits

| Limit | Value | Source |
|---|---|---|
| Title | 200 code points, after trimming | Ruling; core's `TITLE_MAX` |
| Encoded address in the query | 4,000 characters | This design |
| Whole request head (request line and headers, cookies included) | 16,384 bytes | Node 22's `http.maxHeaderSize`, observed 2026-10-17 (`node -p "require('http').maxHeaderSize"` on v22.21.1); nothing in `src/` or `deploy/` sets another (no `maxHeaderSize`, `--max-http-header-size` or `NODE_OPTIONS`, searched 2026-10-17) |

Why 4,000: the signed-out path nests the whole Save address inside `/login?next=`, encoded a second time (§5). Each `%XY` the bookmarklet sent becomes `%25XY`, so the address can grow to 5/3 of its length. 4,000 characters plus a 200-code-point title (at most 2,400 encoded characters) is about 6,500 characters, at most about 10,800 after that second encoding, which leaves over 5 KiB of Node's limit for the rest of the request line and the headers, cookies included. A request over Node's limit is refused with a 431 before the app runs, so the app cannot show a page for it; the bookmarklet's check is what prevents it. **Assumption:** Cloudflare's own URL limit is not lower than this. Not checked.

## 2. The Save page (GET)

`GET /save` behind `requireSession`, with the signed-out change in §5.

**It never writes** **(ruling)**. Any site can open it, and the SameSite=Lax session cookie rides along on a top-level GET, so a GET that wrote would let any page save links into the owner's library. It also reads no owner data: it is filled only from its own query. Whether a link is already saved is shown after Save, from the POST's answer (§3), so the GET has nothing of the owner's to leak. (Reading the session may refresh it in the auth database, as on every signed-in page; "never writes" means no write to the links database.)

**Fields** (rendered through `page()` and the theme tokens, per `src/web/AGENTS.md`):
- **Address:** a labelled `type="url"` field, required, filled from `url`. Its host is shown under it in plain text ("Saving a page from example.com"), so a page that changed what the bookmarklet read is visible. The field is editable, so a bare `/save` works as a plain "add a link" form with no extra code.
- **Title:** a labelled field, filled from `title`. Blank is allowed: the link then has no title and its card shows the address. A title over 200 characters is not cut by the page; core refuses it on Save, and the page shows core's message.
- **Why:** an optional `<textarea>` labelled "Why are you saving it? (optional)", always empty on arrival.
- **Save** (primary). Controls are at least 44px tall.

All prefilled values are escaped with `escapeHtml` into `value` attributes. The query is untrusted and is never put into a script.

`?long=1` renders the page with the long-address message and no form. An unknown or missing `url` renders an empty form.

**After an answer, the address is cleaned.** Once Save has an answer (saved, already saved, or brought back), the page calls `history.replaceState(null, "", "/save")`. A reload or a restored tab then shows an empty form, not a filled one that looks unsaved. Before Save has an answer, the query stays in the address bar, so a reload (including the one §5's signed-out message asks for) refills the form. That is the purpose of `replaceState` here (settled as written: controller ruling, 2026-10-17).

**Framing.** The page answers with `Content-Security-Policy: frame-ancestors 'none'` **(ruling)**, beside `Cache-Control: no-store`. The live site sends no framing header and Cloudflare adds none (checked 2026-10-17, per the ruling), so this header is the only thing stopping another site from framing the page under a fake Save button.

**Close.** Close calls `window.close()`. If the tab is still open afterwards, the page shows "You can close this tab." in its place. Which windows a script may close varies by browser and by the tab's history (the sign-in round trip adds entries), so the page checks rather than assumes.

## 3. Saving (POST)

### Core

A new use case, `savePage(deps, owner, input)`, in a new `src/core/save-page.ts`. `input` is `{ url, title, why, savedBy }`, where `title` and `why` are strings or null. It:
- calls `saveLink` with `title` as given (so `normalizeTitle` trims it, treats blank as none, and refuses more than 200 code points) and `why` as `{ text, source: "asked" }` when given **(ruling: stored as `asked`, like Tell me why)**. `saveLink` drops a blank why;
- passes `saveWaitMs: 0`. The Save page does not show the page's text, so it does not wait up to `SAVE_WAIT_MS` (4 s) for the fetch; the kick still sends the new link's snapshot ahead of the backlog. The web door's deps do carry `snapshots` and `saveWaitMs` (`src/start-server.ts` passes them to `createApp`, which hands the same deps to `webApp`), so without this a web save would wait;
- returns `{ link, created, whyKept }`. `whyKept` is false when the owner gave a why and the link kept a different stored `stated` or `asked` why (a repeat save), so the page can say so instead of dropping it silently.

**Dedupe is unchanged** **(ruling)**: same `url_key`, same link, `created: false`, and only a missing why is filled by `saveLink`. A repeat save whose stored why is an AI's guess is handled next.

**A repeat save over an `inferred` why** (controller ruling, 2026-10-17). `savePage` leaves `saveLink` unchanged. Then, when the owner gave a why and the stored one is `inferred`, it applies `tellWhy`, which replaces only a missing or inferred why. So the Save page's why behaves like Tell me why. Over a `stated` or `asked` why it keeps the stored one and the page shows it (`whyKept: false`).

**Titles.** Core's one title rule applies unchanged. A new link saved with no title does not take the fetched page's title: that is not in #129 (controller ruling, 2026-10-17), and core keeps today's title rule. If wanted later, the show-time fallback (one core helper, `title ?? snapshot title ?? address`, used by every card and by MCP output) is its own issue.

### The door

`POST /save` in `src/web/http.ts`, taking `jsonBody({ url: isString, title: isStringOrNull, why: isStringOrNull })` (`isStringOrNull` is a new type check beside `isString`), then `session`. The body is JSON under `AUTH_BODY_LIMIT` (16 KiB), so it is read before the session check, as the other JSON POSTs are; only a body larger than the auth cap is read after the session (#145 comment 6239312351). It calls `savePage(deps, owner, { url, title, why, savedBy: caller.savedBy })`. `savedBy` is the session caller's, which is `"web"` (`WEB_SAVED_BY`, `src/auth/session.ts`) **(ruling)**; the door never writes the literal.

It answers 200 with `{ id, created, whyKept, state, savedAt, title, url, why }`, read from the returned link. Refusals use `homeAction`, plus `invalid_url` → 400 for this route only (`HOME_REFUSALS` maps `not_found`, `conflict` and `invalid_input` today), each with core's message.

`saveLink` has one door caller today, the MCP tool (`src/mcp/server.ts`); the Save POST is the first web route that saves a new address.

### What the page shows

- **Saved** (`created: true`): "Saved" with Close **(ruling)**.
- **Already saved, active:** "Already saved on {date}" with a link to it **(ruling)**; the date through `savedOn` (`src/web/page.ts`). "A link to it" is the saved title (or the address), a real link to the page in a new tab, shown with the link's why and date on the Save page itself (controller ruling, 2026-10-17). A link into the library, such as a search for its title, would not reliably land on that one link. That view is built by the page's script from the POST's answer, so `openLink` (a server template) can't render it; the script builds the same anchor (`target="_blank" rel="noopener noreferrer"`, the title as text) inside an element carrying the link's `data-id`, and the page includes `openedScript` for it, so an opening posts the existing `/links/opened` and is recorded (`src/web/AGENTS.md`, #124).
- **Already saved, archived:** the same line, plus **Bring it back** **(ruling)**.
- **`whyKept: false`:** under the line, "It already had a reason, so yours wasn't saved: “{stored why}”".

### Bring it back

Bring it back posts `{ id }` to the existing `POST /home/unarchive`, which calls core's `unarchiveLink` (`src/core/worth-a-look.ts`): it makes the link active only while it is still archived, and answers 409 otherwise. No new route: that route is already in `CHECKED_PAGES` and has its two-owner test. On 204 the page shows "Back in your list" with Close; on 409 or 404 it shows the route's message. Bringing a link back is not a removal, so it has no Undo bar.

## 4. Safety

- **Origin check.** `/save` joins `CHECKED_PAGES` in `src/app.ts` **(ruling)**. One entry covers the GET and the POST, which share the path. A foreign `Origin` is refused on both, and a missing one on the POST. A top-level GET navigation carries no `Origin` header (the Fetch standard adds it to GET only for CORS requests), so the bookmarklet's GET passes. **Assumption:** current Chrome, Safari and Firefox behave this way for a `window.open` from another site; the browser check in Testing confirms it.
- **Route guard** **(ruling).** `GET /save` gets a `READ_ROUTES` entry: `noOwnerData: "the save form, filled only from its own query"`. `POST /save` gets a `WRITE_ROUTES_TESTED` entry naming its two-owner test.
- **Framing:** `frame-ancestors 'none'` on the Save page (§2).
- **No write on GET** (§2), with a test.
- `savedBy` is the session's `"web"` (§3).

## 5. Signed out

**(Ruling)** A signed-out owner goes to sign-in, then comes straight back to the filled-in Save page.

Today `requireSession` (`src/web/require-session.ts`) redirects every signed-out request to a bare `/login`, and `returnAfterLogin` (`src/auth/login-return.ts`) accepts only the OAuth authorize path. Accepting the save path in `returnAfterLogin` alone would not be enough, since nothing would send it. So the change has two halves, both written and checked in `src/auth/login-return.ts`, where rules about who may call live (AGENTS.md "Doors hold no rules"; ROADMAP 2026-10-13):

1. **The sender.** `login-return.ts` exports `SAVE_PATH = "/save"` (the web door imports it for its route) and `saveLoginRedirect(url: URL)`, which returns `/login?next=<encoded /save?url=…&title=…>`, built the same way as the existing `loginRedirect`. `requireSession` takes an optional way to build the redirect; only `GET /save` passes `saveLoginRedirect`. Every other page keeps redirecting to a bare `/login`, and `POST /save` keeps the bare redirect too (§6).
2. **The receiver.** `returnAfterLogin` accepts a second path. Its safety rules:
   - `next` is parsed against the fixed placeholder origin, as now; anything whose origin is not the placeholder goes home. This keeps refusing another origin, `//evil.example`, `/\evil.example`, `https://evil.example/save` and `javascript:` URLs.
   - The parsed `pathname` must be exactly `/save`. Dot segments are resolved by the parser before the comparison, so `/x/../save` passes as `/save` and `/save/../connections` does not; `/save/`, `/saveX`, `/Save` and `/save%2F` all go home.
   - The return is rebuilt, not passed through: `/save` plus a fresh query holding only `url` and `title` (each kept only when present, re-encoded with `URLSearchParams`). Any other parameter, a fragment, and repeated parameters beyond the first are dropped. The output is therefore always this site's `/save` with at most those two values.
   - The authorize path is still returned as now (path and its query).

Returning to the Save page is safe even with a hostile query: the GET never writes, its values are escaped, and the owner still has to tap Save.

The login page needs no change: it already goes to `data-next`, escaped, after sign-in (`src/web/pages.ts`).

## 6. Errors and edge cases

| Case | What happens |
|---|---|
| Not http or https (`file:`, `about:`, a browser's own pages), or an address with a username or password | Core's `invalid_url` refusal (`urlKey`), shown on the page; nothing saved. |
| Title over 200 code points (a hand-made or Shortcut address) | Core's "A title can be at most 200 characters.", shown under the field; the owner shortens it. |
| Address over 4,000 encoded characters | The bookmarklet opens `/save?long=1` (§1). |
| Request head over Node's 16 KiB | A 431 from Node before the app runs; no page can be shown. The 4,000 check keeps the bookmarklet under it. |
| Session expired between the GET and the POST | `requireSession` redirects the POST; the page's fetch uses `redirect: "manual"` (as `CARD_FETCH` does, `src/web/tell-why.ts`), sees the redirect, and says "You were signed out. Reload this page to sign in and come back." The query is still in the address bar (§2), so a reload signs in and refills the address and title. An edited title and a typed why are lost. Accepted: rare, and keeping the why would put private text in a URL or browser storage. |
| Save tapped twice, or two tabs | The second save gets `created: false` (dedupe in one store write), so it shows "Already saved". |
| A host page changed what the bookmarklet read | The Save page shows the address and its host before anything is saved (§1). |
| Pop-up blocked | **Assumption:** a bookmarklet tap counts as a user gesture, so `window.open` is allowed. With `noopener`, `window.open` returns null either way, so a block cannot be detected; the browser check in Testing confirms it is not blocked. |
| Close does not close the tab | "You can close this tab." (§2). |
| Already saved and archived, then Bring it back after something else made it active | `/home/unarchive` answers 409 with its message. |
| A link deleted on the web (#126), saved again | #126 is not built yet, so this design does not decide it. Whatever #126 does with a repeat save of a deleted link's address applies here too, since both go through `saveLink`. |

## 7. Install (Apps and keys page)

A new section on `src/web/connections-page.ts`, "Save from your browser", after Agent keys **(ruling: a drag link, plus phone steps with code you can copy, on the Apps and keys page)**. `webApp` gains the public origin as an option (from `auth.options.baseURL` in `src/app.ts`) so the page can build the code with `bookmarkletCode`.

- **Desktop:** a link styled as a button, "Save to Aye-AI-AI Links", whose `href` is the bookmarklet code (escaped for the attribute), with the line "Drag this to your bookmarks bar. On any page, click it to save that page." Clicking it on this page opens the Save page for the Apps and keys page itself, which is harmless.
- **Phone:** the code in a read-only `<textarea>` with **Copy code**. It is the element's text, not an attribute: the route guard's outside-request check (`outsideRefs`, `src/web/outside-refs-test-kit.ts`) skips `<a>` attributes but would flag an `<input value>` holding the origin. Copy code uses the clipboard API; where it is unavailable, the field stays selectable for copying by hand. The steps:
  - **iPhone and iPad (Safari):** bookmark any page; open Bookmarks, tap Edit, edit that bookmark, rename it, and replace its address with the copied code. To save a page, open Bookmarks and tap it.
  - **Android (Chrome):** bookmark any page; edit the bookmark, rename it, and replace its URL with the copied code. To save a page, type the bookmark's name in the address bar and tap the bookmark in the suggestions.

**Assumption:** these phone steps work in current iOS Safari and Android Chrome. Not checked; the implementation PR tests each on a device and corrects the wording.

The section carries no owner data, so the route guard's existing `GET /connections` entry is unchanged.

## Testing

Each test is written red first.

- **`bookmarkletCode`** (run in a `node:vm` context with a fake `location`, `document` and `window.open`): it opens exactly `<base>/save?url=…&title=…` with `"_blank"` and `"noopener"`; the title is trimmed and cut to 200 code points, with a 201st emoji dropped whole; an encoded address of 4,001 characters opens `<base>/save?long=1` and 4,000 opens the full form; it evaluates to `undefined`; it touches nothing else on the fake document (the fake records every property access and write, and the test asserts none beyond `location.href`, `document.title` and `window.open`); the code contains no `%`; the base is `AYE_BASE_URL`'s origin, not the request host.
- **`savePage`** against `FakeStore` and the SQLite store through the store contract: a new link stores the why as `asked` with `savedBy: "web"`; a blank why stores none; a 201-code-point title is refused and no link is written; a repeat save returns `created: false`, fills a missing why, and over an existing `inferred` why it replaces it through `tellWhy` and `whyKept` is true; over a `stated` or `asked` why it keeps the stored one with `whyKept: false`; it does not wait for the fetch (a kick that never settles does not delay it); another owner's link with the same address is untouched.
- **A GET never writes:** signed in, `GET /save?url=<new address>&title=…` answers 200 with the fields filled, and afterwards the link count and the snapshots table are unchanged. The same with the address of a link A already saved: still no write, and the page does not say "Already saved".
- **Two-owner test for `POST /save`:** B posts A's saved address with a why. B gets `created: true` and a link in B's library; A's link keeps its why, title, `savedBy` and state, and A has no new link. B's answer carries nothing of A's (no "Already saved").
- **`CHECKED_PAGES`:** `GET /save` with a foreign `Origin` gets 403; `POST /save` with a foreign `Origin` and with none gets 403 and writes nothing; with the site's own `Origin` it saves.
- **Route guard:** the `READ_ROUTES` and `WRITE_ROUTES_TESTED` entries; the guard's existing check that A's HTML pages make no outside request covers the Save page.
- **Headers:** `GET /save` answers `frame-ancestors 'none'` and `no-store`; other pages are unchanged.
- **Refusals:** `ftp://x` and an address with a password get 400 with core's message and write nothing; a body over 16 KiB gets 413.
- **Signed out:** `GET /save?url=…&title=…` without a session redirects to `/login?next=` carrying that path and query; `GET /search` and `POST /save` without a session still redirect to a bare `/login`.
- **`returnAfterLogin` safety:** `/save?url=…&title=…` comes back as `/save` with the same two values; an extra parameter and a fragment are dropped; `/save/`, `/saveX`, `/Save`, `/save%2F`, `/save/../connections`, `//evil.example/save`, `/\evil.example/save`, `https://evil.example/save` and `javascript:alert(1)` each return `/`; the authorize path still returns as now. A round trip: `saveLoginRedirect`'s `next`, passed to `returnAfterLogin`, gives back the same Save address.
- **The page:** Saved, Already saved (active, its title a new-tab link inside a `data-id` element whose click posts `/links/opened`), Already saved (archived, with Bring it back posting `/home/unarchive`), the `whyKept: false` line, the long-address message, the signed-out message on a manual redirect, and `replaceState` only after an answer.
- **Install section:** the drag link's `href` is `bookmarkletCode`'s output for the configured origin; the copy field holds the same text; the phone steps are present.
- **In browsers** (desktop Chrome, Safari and Firefox; iPhone Safari; Android Chrome), recorded in the PR: the bookmarklet on an ordinary page and on a page with a strict CSP opens the filled Save page in a new tab; the GET passes the origin check; Save, Close and the signed-out round trip work; and a Chrome render at 1280px and at 390px.

## README and ROADMAP

The implementation PR:
- updates README.md: the Save page and the bookmarklet in what the owner can do on the web, with where to install it (AGENTS.md "README in the same PR");
- adds a dated ROADMAP.md decision-log entry recording the rulings, the controller's answers on the title rule, a repeat save over an `inferred` why and the "Already saved" link, the `returnAfterLogin` change, and that the share sheet will open the Save page rather than go through `api/` (design spec line 50).
