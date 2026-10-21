# Roadmap

**Goal:** save links by talking to any AI, find them again from a vague memory, get nudged back to the ones that matter now, and see them on a calm, visual page. Full design: `docs/specs/2026-10-10-aye-ai-ai-links-design.md`.

**Current phase:** Later

Tasks live in GitHub issues under each phase's milestone: https://github.com/Nostoi/aye-ai-ai-links/milestones

## Phases

| Phase | Outcome | Status |
|---|---|---|
| Phase 0 · Setup | Repo, README, AGENTS.md, this roadmap, `npm run check`, pre-push hook, CI | done |
| Phase 1 · Save & find | Core, SQLite store, keyword search, MCP over the tailnet with agent keys. Claude Code and Codex can save, search and get links | done |
| Phase 1b · ChatGPT spike | Throwaway toy MCP server answers: can ChatGPT Business add a write-tool connector, does it work on mobile, does no-auth allow writes, do read-only annotations skip confirmation | done |
| Phase 2 · Smart | Page snapshots, meaning search, profile, focus log, digests | done, except #68 (waits for search-log data) |
| Phase 3 · Phone | Web login, OAuth (CIMD, DCR fallback), owner-isolation tests, then the app public on 443 (a Cloudflare Tunnel, after Tailscale Funnel). ChatGPT and Claude apps connect | done |
| Phase 4 · Calm desk | The web page (layout A). Repo goes public afterwards | done |
| Later | In the owner's order: openings everywhere (#124), Keep handy (#125), dead-link checks (#128), a saved copy of each saved page (#135), bookmarklet (#129), export (#130), delete with Undo (#126), AI endpoints for a local AI, ChatGPT and Claude (#159), a calmer Home and All links (#191: #192–#197), saved summaries (#160), stats and what they say about you (#161), AI-chat openings through a redirect link (#133), then import (#131) and scheduled digests and notifications (#132). Unordered: web search logging (#134), a site's icon when a page names no preview image (#149) | current |

## Decision log

Newest first. Each entry is dated; later entries override earlier ones and the spec.

- **2026-10-21:** Tidy up shipped (#198, PR 3 of 3; design: `docs/specs/2026-10-21-tidy-up-design.md`). #198 is done. Home offers it from a quiet line at the bottom when at least five links are old, and a session is five of them, one at a time.
  - **Deviations from the spec (Part 3):** the finish screen has no "Five more", and Home's start line returns whenever five more links qualify. Links whose page seems gone are left out of Tidy up. The saved and opened line reads "You haven't opened it from here", because only the latest opening is stored.
  - **Keep waits 180 days** before a link can come up again (`tidyKeptAt`, in the export since version 2).
- **2026-10-21:** A space page works like All links (#214; plan: `docs/plans/2026-10-21-space-page.md`). The colour block is gone; the header is the name with its colour dot, a quiet **Change** link, the description, and a kind line for projects only. A space can be ordered newest, oldest or recently opened (`openSpace` takes an order; the choices come from `link-orders.ts`, shared with All links), and **Search this space** is `/search?tag=<key>`.
  - **Settled:** the space query already supported every order, so no store or search change. A search in a space finds links out of your lists too. When nothing in the space matches it says so and offers **Search all your links**, with no second search to count matches elsewhere. A blank Search this space lists the space's newest links.
  - **Decisions:** Out of your lists for a space has no sort and never reads `order` (a cursor made for another order gets the 400 restart page). The phone sort is a select on the space page only; All links' phone select stays deferred (2026-10-20). **Change** goes to `/tags#tag=<key>` and the Tags page opens that row's panel on load; an unknown key opens nothing. An unknown `tag` on `/search` gets the space-missing 404; a blank one is no tag. The select leaves the newest choice nameless so it sends no `order`, rather than disabling it. Out of your lists keeps its empty card and List / Pictures switch in the first page always and the theme (`:has()`) shows one or the other, so rows leaving the page and Undo need no script.
- **2026-10-21:** Put it away (#198, PR 2 of 3; design: `docs/specs/2026-10-21-tidy-up-design.md`). A link put away is archived with a date (`putAwayAt`); an archived link without one is stale. The wire value stays `archived`, and an AI puts a link away with `update_link {putAway: true}`.
  - **Owner ruling, "show it while it fits":** a put-away link shows again on Home (as the featured card) and in the digest while a focus entry written after it, inside the focus window, fits it. It rejoins your lists only when you open it or choose **Bring it back**. This replaces the spec's "back in its lists as soon as it matches".
  - **Other deviations from the spec:** a Handy tile's menu keeps its two rows and has no Put it away; the finish screen of the Tidy up session (PR 3) has no "Five more", and Home's start line returns whenever five more links qualify; links whose page seems gone are left out of Tidy up and of coming back, and Home's gone row stays the one place that asks about them.
  - **Export version 2** adds `putAwayAt` and `tidyKeptAt` to each link in `links.json`; version 1 files still parse. `tidyKeptAt` is stored now for PR 3's Keep wait, so the format changes once.
  - **Menu:** a card's ⋯ menu has six items, and Home's Also today rows seven (`src/web/AGENTS.md`).
  - **Undo** follows the 2026-10-19 delete contract: it applies only while the link still has the state and put-away date the action left.
- **2026-10-21:** "I'm done with it" becomes **It's stale**, and its list section "Links you're done with" becomes **Out of your lists** (#198; owner: "it's stale feels less threatening and irreversible"). Copy only: the menu row, Home's featured button, the gone line, a Handy tile's buttons, the Undo bar, the all-links and space pages, and the bookmarks export's folder. The Undo bar for It's stale reads **Let go.** (bold) then "You won't see it again unless you search for it.", through `showUndo`'s new optional title. The wire value stays `archived`, as do the routes (`/home/archive`, `/all/done`, `/spaces/done`), so an AI still sends `state "archived"`. Earlier entries keep the old words as dated records.
- **2026-10-20:** One action at a time on a card (#208). These card actions (I'm done with it, Delete link including the edit dialog's, Keep handy, Not handy anymore, Remove saved copy, It still works, Home's Not now, and a Handy tile's buttons) share one busy mark, `cardBusy` in `CARD_FETCH`. A second action sends nothing until the first has finished: its answer, the reading of it, the page update and the Undo offer. This replaces each action's own guard and Home's `isConnected` checks, and it ends a late answer acting on a card another action deleted or replacing another action's Undo bar.

- **2026-10-20:** All links as a quiet list (#194, part of #191). It lands in three PRs: (1) the edit dialog finds a card's title and picture by the `data-card-title` and `data-pic` markers, and `editMenu` takes an options object, with nothing visible changed, so #195 builds on it; (2) Saved copy moves from the ⋯ menu to the card's grey line; (3) the list rows and the List / Pictures switch.
  - **Owner rulings, 2026-10-20 (#194 comment 6304189305):** the switch remembers per device, through a cookie the page's script sets and the server reads, with no server-side setting; it is on space pages too, sharing the one choice; Saved copy leaves the menu everywhere and sits on the grey line on All links, space pages and search results; space-page rows keep the amber Tell me why and don't repeat the page's own space; months stay; a card whose page seems gone shows one saved-copy link. Deferred: the phone sort dropdown, hiding Search instead on phones, and the dark Show older button.
  - **Design rule 4's one exception:** the Pictures view of All links and space pages shows each picture across its card, as the large-picture view #191 keeps behind the switch (`src/web/AGENTS.md`). The list is the default.
  - **Space pages group by month**, as All links does, so their rows drop the saved date.
- **2026-10-20:** Home, words first (#195, part of #191). It lands in two PRs: the compact Handy tiles and simpler Your spaces first, then Worth a look with the card menu after #194's card markers, `editMenu` options and the move of Read saved copy out of the menu.
  - **Owner rulings, 2026-10-20 (#195 comment 6304189584):**
    - **Handy** tiles are compact cards: a small picture, the title, the site and the ⋯. On a phone every tile stacks as a row; the sideways scroll goes.
    - **Your spaces:** each card shows the space's name and three recent titles (names only on a phone, as #195 says), with no picture mosaic and no menu.
    - **Worth a look:** Also today rows get a six-row menu (I'm done with it, Not now, Keep handy, Edit, Remove saved copy, Delete), an exception to the five-item rule on Home only. The featured card's ⋯ leaves out I'm done with it and Not now, which are visible beside it. A link that seems gone is an amber Also today row using the shared gone line; It still works hides the warning and keeps the row. Only the featured card asks Tell me why; rows show the website and date. The reason wording stays as it is, restyled as a dot line in the space colour. Rows don't offer Read saved copy, except a gone row: its warning line keeps **Read the saved copy**, since for a page that's gone the copy is often the only way to read it (#195 comment 6304329071).
  - **Building Worth a look, 2026-10-20:** the featured card's grey line is the shared `cardLine`, so its copy link reads **Saved copy**, as on every other card, not the mockup's "Read your saved copy". Once It still works hides a gone row's warning, its **Read the saved copy** hides too, since the row is then an ordinary row. Not now and Keep handy change a card only after the server agrees, so a refused Not now can't bring back a card that I'm done with it took out. Home reads a why as All links' rows do (`whyText`): an AI's guess reads "Why (a guess): …", where it used to read as a quote followed by "(a guess)".
- **2026-10-20:** Navigation (#196, part of #191). The top bar is **All links**, **Spaces and tags**, **Ask AI** (an outlined button, only with the AI set up) and an account menu holding **Profile**, **Apps and keys**, **Your data** and **Sign out**; on a phone the logo, **Ask AI** and a menu button that also holds the two page links. **Your data** links to that section of Apps and keys (`/connections#your-data`), as #196 describes.
  - **Owner ruling, 2026-10-20 (#196 comment 6297978107):** the nav says **Spaces and tags**, not **Tags**.
  - **This supersedes** the 2026-10-19 Ask AI rulings that Ask AI "looks like the other menu links" and that "the menu is today's menu plus Ask AI before Sign out" (owner ruling, 2026-10-20, #196 comment 6298376762: the approval of the redesign, #191, replaces them). The dated design `docs/specs/2026-10-19-in-app-ai-design.md` is left as written.
  - **No-AI snapshots narrowed.** The 2026-10-19 line "with no AI set up, every page is byte for byte as before" held the pages against the Ask AI panel. It does not freeze them against a deliberate redesign: `src/web/__ask_off__` is regenerated with `vitest -u` when a PR changes a page on purpose, and the panel must still add nothing when it is off (#191).
  - **Dismissal.** The account menu closes on Escape pressed inside the bar, on a click outside it and when focus moves out of the bar; it leaves an Escape that Ask AI's panel already took.
- **2026-10-20:** Calmer Home and All links (#191), and which picture a card shows (#193, its first part).
  - **Owner rulings, 2026-10-20:**
    - **Order.** The redesign (#192–#197) goes ahead of the rest of the Later order: #160, #161, #133, #131 and #132 (#191 comment 6297978367).
    - **Design rule 4 is reversed.** "Pictures jog memory: real page images, shown large" becomes "pictures are small accents" (`src/web/AGENTS.md`). #194 and #195 make the pictures small on All links and Home.
    - **Detection, the simple version** (#193 comment 6297999133). Known hosts show the site's icon instead of their preview: github.com social cards and x.com link cards. The owner can switch any card to its icon through **Edit title and picture…**, which is a later PR. There is no AI image check.
    - **Picture-less cards** show initials on a neutral background, never tinted with the space's colour.
  - **Controller rulings:**
    - **The hosts** are github.com, x.com and twitter.com, with or without `www.`. No other subdomain counts. They are judged on the saved address, so a short link that redirects to GitHub keeps its preview. The rule is `isWordPictureHost` in `src/core/word-picture-host.ts`. A known host's snapshot records no preview, only its icons.
    - **GitHub's icon.** `rel=fluid-icon` becomes a kept icon rel. It is GitHub's only icon of 64 px or more; its other PNG is 32 px. A known host with no usable icon shows initials.
    - **The neutral background** is `--pic`, a grey apart from both `--bg` and `--surface`, so a box shows on a dark page. Each card type's picture box, the Handy postcard and the edit dialog's preview use it. The space dots stay. The mosaic's empty cells (`.tint-*`) stay until #195 makes spaces words only.
    - **Existing links converge in the icon backfill's sweep, every 15 s.** This replaces a once-per-start pass, after the solution challenge (REVISE). A live known-host link whose snapshot still names a preview is read afresh:
      - It is read whatever its snapshot's status (`extract_timeout`, `extract_crashed` and `extract_out_of_memory` keep metadata), so the current icons are found rather than stale ones.
      - The preview and its fetched picture are dropped and the fresh icons recorded. The snapshot's status, title and text stay.
      - A link restored by a delete's Undo is picked up by the next sweep.
  - **Changes to #149** (ROADMAP 2026-10-19 and #149 comment of 2026-10-19):
    - **`imageUrl`.** For a known host, get_link's `imageUrl` and the export's `page.imageUrl` are null. This replaces the controller default "get_link's imageUrl stays the page's preview address".
    - **A known-host link marked as gone** is read and does not wait until it works again. If the read fails for good, it shows initials.
    - **A fresh read that fails** for good (a 404, say) records no icon, so the card shows initials, as #149's backfill does. One that may pass (a 5xx, 408 or 429, a network error or a timeout) keeps the preview and is tried again later.

- **2026-10-20:** Readable fallback titles (#197, part of #191). A card's title is `displayTitle` (`src/web/display-title.ts`): the stored title when it is not blank and not wholly a web address, else the saved page's title under the same two checks and `titleFits`, else `Post by @user` for an x.com or twitter.com post, else the last path segment with its site (`Iso cycles — scenario.com`), else the site. It is display only: the stored title, the edit dialog's `data-title`, `initials`, the saved-copy page, the Ask AI answer text, MCP and the export are unchanged. The edit and Undo answers carry the shown title (`shown`) so a card keeps it after Save or Undo.
  - **Supersedes** `docs/specs/2026-10-17-edit-title-picture-design.md`'s "an empty result means no title (the card shows the URL)": the card now shows the fallback; the spec is left as written. Stored titles are still not rewritten.
  - **Accepted:** two addresses that differ only by query or fragment can show the same built title (for example two `youtube.com/watch?v=` links with no page title); a page title usually comes first.
- **2026-10-20:** Edit in the Ask AI panel (#183).
  - **Owner rulings, 2026-10-20:**
    - **O1.** Edit opens the existing title-and-picture dialog, unchanged in what it edits.
    - **O2.** Edit appears only under the change lines for links the AI saved or changed. Cards in a plain answer get no buttons.
    - **E1** (in chat). Opened from the panel, the dialog doesn't show Delete link. This reads O1's "unchanged" as covering what the dialog edits.
  - **Rulings after the solution challenge** (REVISE):
    - **E7** (replaces E2). Pressing Edit reads the link's card again (`GET /ai/card/:id`) and replaces every panel card for it. The dialog opens at once and waits, busy, then fills from that fresh card. If the link can't be read, it closes and the line says why: "Couldn't load this link. Try again.", or on a 404 "This link was deleted." and E4 applies.
    - **E3.** Reads of one link's card are numbered, and only the latest one started is drawn and stored. That covers the dialog's Save and Undo, the panel's Undo and E7.
    - **E4.** When a save's Undo deletes the link, every line's Edit for it goes, and a redraw shows none.
    - **E5.** With the AI on, the dialog's Undo bar follows the link, not the card element: a late Save still offers Undo while any card for the link is on the page.
  - **The boundary:** after a dialog edit, the page's own cards on All links, search and space pages update, as they always have. Home and Handy cards don't; they update on reload.
- **2026-10-20:** Ask AI page awareness (#159, PR 3). Design: `docs/specs/2026-10-19-in-app-ai-design.md`; the mockup's screen 2 governs over its text.
  - **Owner ruling, 2026-10-20:** the "Earlier, on X" line can be pressed to show the earlier messages, Undo included, and pressed again to hide them.
  - **Controller rulings:**
    - Each turn sends `page`: the address, the place, the first 60 link ids on the page and how many it shows. The server puts them in a `<page>` system block as JSON strings, and page ids never vouch for a card.
    - Ids come from `[data-id]` elements outside the panel and outside anything `[hidden]`, read when the message is sent.
    - When a reply names a card on the page, the page's other cards dim (seen on a wide screen; on a phone the sheet covers the page) until the next send, Start over or close; a watcher dims cards added meanwhile. The fade is not stored.
    - Each stored entry keeps the `path` and `place` it was made on; the stored version stays 1, and an entry without them counts as made on the current page. Messages from other pages sit behind the Earlier line, which says what the last earlier exchange saved, else what was asked.
    - A failed message from another address offers only the search, not Try again, so a retry never asks about a page the owner didn't mean. This overrides the spec's two buttons for that case.
    - The request-size cap now counts the whole body, page included.
  - **Two departures from the spec's line 120:** the page sends up to 60 ids plus a count of all shown, not 24, because Show older and Show all add more links; and it sends ids only, no titles, because the model reads titles with its tools, which keeps page-supplied text out of the prompt.

- **2026-10-20:** Ask AI replies are short, with cards (#185).
  - **Owner's decision.** A new in-app prompt, a cap of 5 cards per reply, and a plain-text safety net for leaked Markdown. No `answer` tool: in a measured comparison it did no better than the prompt (#185 body). Structured outputs were left out of scope and not measured.
  - **Controller rulings,** after the solution challenge (REVISE; #185 comment 6289817200):
    - Markers are read before any tidying, so tidying never makes a card.
    - A marker past the fifth card is shown as the link's title in plain text, and the history keeps the marker. This replaces the issue body's "removed", which was the controller's wording.
    - The prompt asks for a number of further matches only when a tool gave the total.
    - The cap covers the reply's cards only; a changed link still gets its card under the reply.

- **2026-10-19:** The Ask AI panel (#159, PR 2).
  - **Owner rulings, 2026-10-19:**
    - **Failure copy** (#159 comment 6279458324). With no changes: "<AI> didn't answer: {reason}." and "Nothing was saved or changed." With changes: "<AI> stopped before it finished: {reason}." and the change list. The controller left Try again out of this case, because a retry would repeat the writes.
    - **Undo label** (comment 6281281459). The button reads plain "Undo"; on a field edit, its hover text is "Puts back the title, summary, why and tags."
    - **Menu** (comment 6281345863). With the AI on, the menu is today's menu plus Ask AI before Sign out. The mockup's "Apps" and its missing Sign out predate the current menu.
    - **Edit** (the same comment). Edit is not in this PR; it is #183.
  - **Controller rulings,** after the solution challenge (REVISE, all nine findings accepted; #159 comment 6281505089):
    - **Cards.**
      - A link gets a card only where the reply cites it as `[[link:<id>]]`, and only for a link from the turn's own tool results, read through the owner's store. A changed link that the reply doesn't cite gets its card under the reply.
      - A search alone shows no cards.
      - Cards are rendered on the server, and `GET /ai/card/:id` re-reads one after an Undo. That route is mounted whether or not an AI is set up.
    - **Every change gets a line,** including `get_digest`'s "Marked N links as shown in today's picks."
      - Keep handy and profile lines follow the change's status and source, so a suggestion or an inferred note reads as a guess.
      - Tag changes carry no source, so a tag line never says "(a guess)".
    - **Undo.**
      - A new save: deletes the link, even if it was edited since (the spec's accepted design).
      - A field edit: `/links/edit/undo`.
      - Keep handy: `/tools/undo`, with the change's own rows.
      - Anything else: a line and no Undo.
    - **The history the panel posts.**
      - At most 40 messages and under 400 KiB.
      - The server's `remember` text keeps each shown link's marker exactly as the model wrote it, and is never empty. A rewritten form (`[link <id>: <title>]`) led Claude, in a live check, to "correct" an id that was right.
      - A failed turn with no changes adds nothing; one with changes adds the pair.
    - **Conversation state.** It lives in `sessionStorage`, tied to the signed-in owner and cleared by sign out. A turn interrupted by leaving the page shows a notice on the next page.
    - **The page behind the panel** is not refreshed after a change.
    - **With no AI set up,** every page is byte for byte as before; `src/web/ask-off-bytes.test.ts` holds the snapshots.
- **2026-10-19:** Undo for the in-app AI's link edits (#181), ahead of the Ask AI panel. The owner ruled (#159) that why, tag and summary edits get Undo; the controller added title. The design is the controller's, revised after the solution challenge (#181 comment 6280159207).
  - **What can be undone:** an in-app AI edit to a link's title, summary, why or tags, including a repeat save that fills a missing why. It is undone through the existing `POST /links/edit/undo`. Snooze, state, new saves, profile and tag-kind changes are not covered.
  - **Only the in-app AI records.** Connected agents, Tell me why and the Save page never write a receipt. A link keeps one Undo, its latest recorded edit: an in-app AI edit replaces a pending dialog Undo, and a dialog edit replaces a pending AI one.
  - **Undo acts only while the link still holds what the AI wrote,** whoever changed it since. Otherwise it answers "This link changed since, so nothing was undone."
  - **One Undo per link per turn** (controller, #181 comment 6280665040). Within one turn, the AI's edits to a link extend that link's receipt while the link still holds what the turn wrote, so the AI's usual flow (a repeat save that fills the why, then `update_link`) stays undoable. Only the link's last change that has an `editId` keeps it; an earlier one is nulled. While the turn's chain held, its Undo puts back everything the turn did to that link, although that change's `fields` names only its own call's fields. If another write broke the chain mid-turn, that Undo covers only the edits after the break.
  - **Accepted gaps:**
    - A repeat save's filled why is not listed (so it has no Undo) if the page-text read after it fails. The why was empty before, so no text is lost.
    - An undone, newly inferred project stays in the tag catalog, as a removed tag does today, so filing suggestions can still offer it.
  - **For PR 2:**
    - The Undo route answers the card's title and picture. After an AI Undo, the panel re-reads the link to show the restored summary, why and tags.
    - The panel offers one Undo per link, on the change that carries the `editId`.
- **2026-10-19:** The server may call one configured AI (#159). Design: `docs/specs/2026-10-19-in-app-ai-design.md`. Owner rulings, 2026-10-19 (#159 comments), except the two marked as the controller's.
  - **The principle changes on purpose.** AGENTS.md's "The calling agent does the AI work" becomes "One AI connection, and only when set up". This overrides the 2026-10-10 spec's "never calls an AI model API" row, which stays as a dated record. It settles the #159 half of the 2026-10-18 open conflict; #160 is not yet designed.
  - **`get_digest` calls by the in-app AI are listed as changes.**
  - **The AI's why and tag edits get Undo,** in their own PR before the panel.
  - **The in-app AI's searches are logged in `search_log`** like other agents'. Web-page searches still are not (#134). (Controller, 2026-10-19.)
  - **One behaviour change for connected agents:** an `edit_profile` removal of a note edited since the call read it is now refused with the existing conflict answer (it passes `expectedUpdatedAt`). (Controller, 2026-10-19, #159 comment 6275182173.) The 2026-10-11 entry describing the source-only guard stays as written.
- **2026-10-19:** Deleting a link, with Undo (#126).
  - **Design:** `docs/specs/2026-10-19-delete-link-design.md`, revised after the solution challenge. Two PRs: (1) migration, store, core and purge; (2) web controls, done pages, cursors and README.
  - **Later order** (owner, 2026-10-19, #126 comment 6268810403): #126, #159, #160, #161, then #133, then #131 and #132. The owner confirmed that moving import and digests after the AI group is intended.
  - **Ids are never reused:** `links` is rebuilt with `AUTOINCREMENT`. This is the first shipped table rebuild, and it closes #126 comment 6263878763.
  - **Done pages get the ⋯ menu, the edit dialog and the Undo bar** (lands in PR 2). This replaces the 2026-10-17 ruling "not on the done pages".
  - **Saving an address whose link is deleted** inside the window makes a new link, so the old Undo ends early (owner, in session).
  - **A ready export is a snapshot** kept until its 24-hour expiry; deleting a link does not revoke it.
  - **Controller rulings in this plan:**
    - function migrations;
    - `LINK_UNDO_WINDOW_MS = COPY_UNDO_WINDOW_MS`;
    - a link deleted mid-export carries copy status `removed`;
    - a stale cursor on `/spaces` redirects to the first page, so a missing tag answers 404 there;
    - a link with a saved copy is gone within about two minutes while saved copies are ready, because `purgeRemoved` runs every copy-pass poll;
    - a re-save during the window over a link whose copy still has files leaves an orphan folder for the sweep (Discrepancy 13).
- **2026-10-19:** Export (#130) PR 2 is done: Prepare export, the zip and `bookmarks.html`. Rulings that change `docs/specs/2026-10-18-export-design.md` (controller, 2026-10-19):
  - **R1a:** v1's `picture` gains `pageRole` (`preview` or `icon`, null when `page` is), read with the page picture's bytes. It is still version 1, because no manifest with `picture` was written before PR 2 (after #168).
  - **R2:** `ExportDeps` uses AppDeps' names (`savedCopies`, `readGate`), not the spec's sketch names.
  - **R5:** the previous zip stays downloadable during a rebuild and after a failed one, until it expires.
  - **R9:** start-up deletes only the names a build makes in the `exports` folder, not everything in it.
  - **R17:** sizes are decimal MB or GB; times are UTC.
  - **Found in the build:** v1 also refuses an `ok` copy with no file in a zip; copy image numbers must be strictly increasing (a gap is allowed); front matter also escapes U+FFFE and U+FFFF; an expiry during a rebuild defers its delete until the build ends.
  - **Copy images (architecture review):** a saved copy keeps its text and the images read. A gone image is skipped, so a finished copy's reference to it dangles (spec 237). The first image read that fails or times out skips the rest of that copy's images instead of marking the copy unreadable, unlike spec lines 180 and 316, so a stalled folder costs one deadline per copy.
  - **Gate, after deploy (owner):** download a large export through the public address on a phone; record its size, the time it took, and that `unzip -t` accepts it. Not a CI item. The result goes in a #130 comment; if it fails, file a linked issue.
- **2026-10-19:** Export (#130). Owner rulings, 2026-10-18 (#130 comment 6259932341) and 2026-10-19 (#130 comment 6260957537), which are binding. The design is `docs/specs/2026-10-18-export-design.md`, revised after the solution-choice challenge and approved by the owner on 2026-10-19.
  - **What it is:** on Apps and keys, under "Your data", two downloads:
    - a zip with a versioned `links.json`, the owner's and the pages' pictures, the saved copies as Markdown with front matter, and a `bookmarks.html`;
    - a links-only JSON file.

    There is no MCP tool, CLI command or scheduled export. Import is #131, which follows this format.
  - **The zip is prepared, then downloaded** (owner ruling, 2026-10-19). **Prepare export** shows "Preparing…", then a **Download** link, and the file is kept for 24 hours. This replaces the 2026-10-18 default of a plain download link. The links-only JSON stays a direct download, `GET /export.json`.
  - **Left out:** page snapshot text, the search log, the meaning vectors and search indexes, and keys and auth. These are the 2026-10-18 comment's controller defaults, kept by the approved design.
  - **Re-importing this app's export restores whys, sources and tags as they were** (same comment). So `links.json` keeps every source and date. Removed copies stay as tombstones, in the links-only JSON too, so an import never makes them again.
  - **The approval accepts the design's own answers to its open questions.** The owner did not rule on each one separately:
    - the filename date is UTC;
    - one build runs per owner;
    - zip paths are ASCII, with no title slug;
    - `/export.json` keeps tags, notes and focus;
    - a ready zip is kept 24 hours.
  - **Lands in two PRs:** the manifest and the JSON download, then builds and the zip, which closes #130.
- **2026-10-19:** Backfilling icons for older links (#149, PR C). Controller rulings:
  - **The child's `iconUrls` are checked once, by `boundedIconUrls` in `core/snapshot-store.ts`,** which both `snapshotRecord` and the backfill call (PR B's architecture nit N1).
  - **A link that keeps failing is bounded** (R3): a child that can't start, an abort nobody asked for, or a store write that fails counts as a failure. After five, the link is left alone until the next restart, and nothing is written for it. This departs from spec §8's unbounded backoff for `spawn_failed`.
  - **Spec §10's "a snapshot recorded between read and write" test can't be built,** since an `ok` snapshot is never leased again. One refusal per clause of the write takes its place (R8).
- **2026-10-19:** Finding icons on new saves (#149, PR B). Controller rulings:
  - **`MAX_ICON_URLS` is shared with the extraction child** (R1). This departs from spec §2's "no new import enters the child"; `src/fetch/AGENTS.md` lists the file.
  - **A duplicate icon URL keeps its best-ranked occurrence** (R3), so Photopea gives one candidate.
  - **`snapshotRecord` accepts only string arrays for `iconUrls`,** capped at two (R2).
- **2026-10-19:** A site's icon when a page names no preview image (#149). Owner rulings: 2026-10-17 (#149 body), 2026-10-18 (#149 comment 6259932087) and 2026-10-19 (comment 6260957774). The design is `docs/specs/2026-10-18-site-icon-design.md`, approved by the owner on 2026-10-19 after an independent challenge.
  - **The order:**
    1. the owner's picture;
    2. the page's preview image;
    3. the site's icon, shown whole on a light plate and never cropped;
    4. the title's initials on the space colour, on every card (the site's when there is no title).
  - **A named preview that fails to fetch never falls back to the icon,** for now (comment 6259932087).
  - **A declared preview the server can never use counts as none,** so the icon shows: a `data:` URL, credentials in the URL, or more than 2,048 characters (comment 6260957774). This settles the spec's open question in §1 and §13.
  - **Controller defaults** (comment 6259932087). Any of them can be changed:
    - the 64px floor is measured from the image's bytes, on its shorter side;
    - the owner's picture still fills its box;
    - mosaics show the newest pictures of either kind, with icons whole;
    - `get_link`'s `imageUrl` stays the page's preview address;
    - `favicon.ico` and SVG are refused, so expect initials often.
  - **Where the approved design departs from that comment** (controller rulings, 2026-10-19):
    - the backfill includes links with an owner picture, so the icon shows if that picture is removed;
    - it skips a dead-flagged link only while the link is flagged.
  - **Store rulings** (controller, 2026-10-19):
    - a stored icon is retired inside `recordSnapshot` as soon as a snapshot names a preview, so no reader shows it, whether the preview is pending or later fails;
    - the pending key is the URL and the role (preview or icon), not a generation token;
    - at most two icon candidates are tried;
    - whether a page was looked at for an icon is `image_status`, with no new column.
  - **Lands in three PRs:** A, the schema, the store and the display, which brings initials everywhere; B, finding icons on new saves; C, a one-at-a-time backfill for older links. Each PR updates the README for what it shows.
- **2026-10-18:** Three owner requests join Later, unordered.
  - **#159:** reach a local AI, ChatGPT and Claude through their APIs for chat and saving, alongside the MCP connectors.
  - **#160:** the server keeps an AI-made summary of each link.
  - **#161:** stats over a chosen window (saved, read, saved but not read, put aside), plus an AI reading of what they say about the owner.
  - **Open conflicts, to settle at design with the owner:**
    - #159 and #160 reverse AGENTS.md's "the server never calls an AI model API and needs no API keys", so building them changes that principle on purpose (settled for #159 by the 2026-10-19 entry "The server may call one configured AI");
    - #161's "saved but not read" count meets src/web/AGENTS.md's "No guilt counters".
- **2026-10-18:** Saved copies (#135). Owner rulings, 2026-10-17 (#135 comment 6241001150, binding); the naming ruling is the comment before it (comment 6240109297). The design is `docs/specs/2026-10-17-saved-copy-design.md`.
  - **Overrides the 2026-10-10 spec's "Not stored now: full-page archives"** (owner ruling). That spec stays as written; this entry is the override.
  - **Lands in five PRs:** the ledger and folder store (no callers), then copies of new links with the settings, then the copy pass (the one-time backfill, the image pass, finishing, the sweep), then reading them (the copy page and its pictures, the ⋯ menu row, the gone cards' link, `get_link`'s `savedCopy`), then removing them (remove and Undo, the purge, the All links line).
  - **Where the spec misread the code** (controller rulings):
    - the gone flag is #128's `gone` (`isGone`, `GoneView`), not "dead";
    - the copy reaches cards through a web-only per-page map, not `LinkView`, which is spread into strict MCP outputs;
    - a shutdown during the Markdown step must still give an `ok` snapshot, which needs a change to the extraction runner, and the backfill treats a copy asked for but not received as transient, never `none`;
    - the stored-image route is in `CHECKED_PAGES`, so both copy routes join it;
    - start-up recovery runs before the server listens, since a save can start as soon as it does;
    - the spec's `copyFetcher` seam is dropped: copies reuse the process's page and image fetchers;
    - the copy page records no opening (it runs no script), an exception to `src/web/AGENTS.md`'s opening rule.
  - **Store rulings** (controller): a marker-less folder holding only `.DS_Store`, `.localized`, `Icon\r` or `.aye-tmp` counts as empty and gets a marker; the library id is written to the database before the marker; a write that fails in a running server releases its reservation at once, and any file it can't remove is left for the sweep; only a `no_room` row is ever replaced; an orphan folder at a new copy's path loses only the files the app names, and other files in it stay; every file read, write and deletion needs a passing folder check; finishing is recorded in its own column; request-time usage is its own interface; the settings land with the PR that uses them.
  - **Image references carry a random per-copy nonce** (`images/NN-<nonce>`, controller ruling after an independent challenge). The spec's `images/NN` placeholder is replaced. Finishing then never rewrites page text that looks like a reference, such as a Markdown tutorial's code. It also only shortens the file, so no finishing reserve is needed.
  - **Turndown is given the article element directly:** checked 2026-10-18 to give the same Markdown as the HTML string. Images are numbered only once their reference has survived the conversion, so an image the Markdown never shows is never fetched. A copy the extraction child fails to make counts as not received, and the backfill retries it; only a page with no article gets none.
  - **A save straight onto the Handy shelf can miss its copy** when its page takes longer than the save's 4-second wait, since the link is a kept tool by then. The kept-tool ruling allows this.
  - **The copy pass** (controller rulings): it fetches at most one page per sweep, every 15 seconds or so; a kept tool is never fetched; a link or picture that fails 5 times is marked as such and never fetched again, though a failure while the canary lookup says the network is down doesn't count; a folder that can't be written pauses copies without marking anything failed, and copies resume without a restart; a saved-copy folder is refused inside the release folders by comparing the folders themselves as well as their spelling.
  - **One server per saved-copy folder.** The marker keeps a fresh database off the live folder. It cannot tell a copied database apart.
  - **Reading a copy** (controller rulings): saved-copy files are read one at a time across the whole server (the copy page, its pictures and the copy pass's finishing), each read within 10 seconds, and a copy file over its cap is refused; copy pictures are never cached by the browser, so removing a copy hides them at once; Markdown renders without tables or reference links, and a link keeps its address only for http, https or mailto; markdown-it is pinned at 15.0.2 until 15.0.3 is two weeks old; gone cards offer the copy on every page that shows them, including the done pages.
  - **Removing a copy** (controller rulings): removing is instant with a 60-second Undo, works while copies are paused or off, and frees its space when the copy pass deletes the files after the window; the row stays as an empty marker so the copy is never made again; once deleting starts the copy can't be brought back, and a read already in progress also comes back empty; All links shows a line at 80% (neutral), when almost full or when paused (amber), and none when copies are off; the line counts all owners' copies, since there is one folder and one limit; a copy whose files were deleted by hand gets no more pictures and is never rebuilt; deleting a link (#126) will remove its copy when #126 lands.

- **2026-10-17:** Dead-link checks (#128). Owner rulings, 2026-10-17, recorded in #128 comment 6241000784, which is binding.
  - **The design** is `docs/specs/2026-10-17-dead-link-checks-design.md`. It implements those rulings by reference and lands in two PRs: first the store, rules, runner and checker, then the doors (MCP, the web page and the routes). PR 1 updates the README for what it ships: the checks, gone pages leaving the digest and Worth a look, and gone tools not asked "Still using it?".
  - **Its assumptions are settled.** A3 (It still works clears the streak as well as the flag) and the amber tile for a gone tool on the Handy shelf are owner rulings. A1, A2 and A4 to A7 are controller rulings, accepted as written. All are dated 2026-10-17.
  - **Undo of It still works refuses a row no check could have written** (controller ruling): besides the spec's three refusals, an unflagged row, or any date that is invalid or later than now. **After a store error the runner waits an hour** before its next sweep (controller ruling).
  - **A canary lookup replaces A2's 24-hour rule** (owner ruling, #128 comment 6244310928). When a link's name doesn't resolve, the checker asks the DNS servers directly for `example.com`: the check is dead if that answers, otherwise unknown (`network:ENOTFOUND:offline`). It narrows the outage gap rather than closing it, since a network that recovers between the two lookups still records one dead check. **Keep handy suggestions skip gone links** (same ruling), and home reads them once for the shelf and Worth a look (#152).
  - **The doors PR closes #128.**
    - **The gone shelf tile keeps the square** (owner ruling, #128 comment 6245671142). It copies the Still using? tile: **Seems gone**, with **It works** and **Done**. Cards and the Worth a look gone card keep the full wording.
    - Controller rulings:
      - a snoozed link is never the Worth a look gone pick;
      - I'm done with it on a card hides the card, while It still works hides only the line, both with Undo;
      - agents get the guidance in the descriptions of `get_link`, `search_links` and `list_links`, because INSTRUCTIONS is at its length cap;
      - each view reads tool and check rows once, and Worth a look leaves its gone pick out of the reading picks.

- **2026-10-17:** The bookmarklet and the Save page (#129). Owner rulings, 2026-10-17 (#129 comment 6241001472); controller answers the same day. The design is `docs/specs/2026-10-17-bookmarklet-design.md`.
  - **One tap opens the Save page,** `/save?url=&title=`, with the page's address and title filled in. The title is cut to 200 code points; an address over 3,000 encoded characters opens `/save?long=1` instead. An optional why, then **Save**, then "Saved" with Close. The address is the stable one a phone Shortcut will open later.
  - **The limit is 3,000, not the design's 4,000** (controller ruling). Signed out, the Save address travels through `/login?next=` and back, and `returnAfterLogin` re-encodes `( ) ! ' ~`. At 4,000, an address of `(` came back as a 14,371-character URL, too near Node's 16 KiB header limit. At 3,000, with `'` counted as the three characters it is sent as, the worst case measured across `(`, `/`, `é` and `'` is 11,371, the return URL for `(` (`src/web/save-size.test.ts`). The sign-in page also sends `Referrer-Policy: no-referrer`, so its own long address is not sent again as the Referer.
  - **The share sheet will open the Save page,** not go through a JSON API in `api/` as design spec §2 (line 50) had it. No `api/` door is made for this.
  - **The Save page never writes on GET,** reads none of the owner's data, sends `frame-ancestors 'none'`, and `/save` is origin-checked (`CHECKED_PAGES`). Saving is `POST /save`.
  - **The why is stored as `asked`,** like Tell me why, and `savedBy` is the session's `web`. Dedupe is unchanged. On a repeat save over an AI's guessed why, the owner's why replaces it (`tellWhy`); over a reason someone gave, it is kept and the page says yours wasn't saved (controller answer).
  - **Already saved** shows the date and the link's title (or address) as a new-tab link, with its why; an archived link offers **Bring it back** through the existing `/home/unarchive` (controller answer on the link).
  - **A new link saved with no title keeps none:** it does not take the fetched page's title (controller answer). A show-time fallback would be its own issue.
  - **Signed out, the owner signs in and comes straight back.** `returnAfterLogin` now also accepts exactly `/save`, rebuilt with only its first `url` and `title`; only `GET /save` sends its address to sign-in.
  - **Install** is "Save from your browser" on Apps and keys: a link to drag, and code to copy into a phone bookmark. The bookmarklet never reads selected text.
  - **Where the build departs from the design's wording:** the POST answer also carries `savedOn`, the date in the page's words, because the page's script builds the Already saved view; the Save page reuses `loginRedirect` rather than a copy named `saveLoginRedirect`; and a signed-out `/save?long=1` comes back as an empty form, because only `url` and `title` return.

- **2026-10-17:** Editing a link's title and picture (#145). Owner rulings, 2026-10-17 (#145 comments 6235920412 and 6236065873).
  - **The design** is `docs/specs/2026-10-17-edit-title-picture-design.md`, following the approved "Edit title & picture" mockup. It lands in two PRs: the Handy header first, then title and picture.
  - **Handy's Add and Show all sit in the shelf's header,** beside "Handy". Show all reads "Show all N" with the kept count. The line of buttons under the tiles is gone. An empty shelf keeps its line with Add beside it.
  - **Title and picture (PR 2).** Owner rulings, 2026-10-17 (#145 comment 6236065873):
    - The owner's picture is stored apart from the fetched one (`owner_images`), so a fetch never replaces it. The store's reads alone decide which shows: the owner's, else the fetched one.
    - One title rule for agents and the page: trimmed, blank is none, at most 200 characters. `save_link` and `update_link` now refuse a longer title instead of storing it; stored titles are not rewritten. `update_link` checks it before its handy write.
    - An edit's Undo acts only while the edit is the link's latest and the link still holds what it wrote (`restoreTool`'s rule). Otherwise it is refused, and the page's alert says so; the Undo bar is unchanged.
    - Undoing a picture edit restores the earlier owner picture with its original set time (`link_edits.prior_set_at`).
    - The ⋯ menu and the dialog are on search results (archived links included), All links and space pages, not on the done pages or the Handy shelf. The Handy tiles and the cards share one menu.

- **2026-10-16:** Phase 3 is done; the current phase is Later. Owner rulings, in session.
  - **Phase 3's last checks.** ChatGPT kept its connection by refreshing for about 11 hours, across two deploys (#102 comment 6184365831). #105 is fixed by `offline-access.ts` and closed with no upstream report to better-auth (owner ruling, 2026-10-14). #77 B2's F1 moved to Later as #119.
  - **A stale connected app gets the error page (#119).** A connected CIMD app whose snapshot is not current is sent to `/oauth-error` by the authorize gate, signed in or not, instead of getting admission's raw JSON 400. Admission still refuses it either way.
  - **An unpinned tag shows no color (#120).** `spaceColor` gives a color only for a pinned tag, so its space page band is neutral, matching its cards, and the stored color comes back when it is pinned again. This settles the #96 open question and replaces that entry's band rule. The Tags page is the exception: it is where the kept color is edited, so it still shows it (#120 comment 6224673456).
  - **Undo of I'm done with it keeps no time limit.** The Undo bar closes within 45 s (`UNDO_BAR_MAX_MS`), `/home/unarchive` is origin-checked, and it acts only while the link is still archived, so a late Undo can only make the owner's own link active again. A limit would need a stored archive time for no protection.
  - **Delete is web only, with Undo (#126).** No MCP tool deletes. A soft delete hides the link at once and Undo restores it within 60 s, with no confirmation. A page cursor naming a deleted link restarts from the newest links rather than showing an error. This settles the hand-off in the 2026-10-14 `list_links` entry.
  - **A sign-in that resumes an app's authorize no longer reports a wrong password (#121).** When better-auth refuses the resumed authorize with an OAuth `error` (the app's document went stale, or the signed query expired or was tampered with), `src/auth/resumed-sign-in.ts` answers with a redirect to `/oauth-error?error=<code>` instead, keeping any session cookie and logging the code (never the description). Owner ruling: the expired-query case is included, so an expired query with a wrong password shows the connection message too (#121 comment 6224709211).
  - **Tools you use regularly get Keep handy (#125).** A fourth choice on Worth a look marks a link as a tool. A tool leaves the ordinary nudges and joins a Handy shelf on home. Instead, it is asked about alone ("Still using it?") once it goes unopened for a wait. The wait counts from the later of its last recorded opening or its last answer, starts at 30 days, doubles on each "Still using it" with no opening since, stops at 120 days, and goes back to 30 on any opening.
  - **Keep handy's design** is `docs/specs/2026-10-16-keep-handy-design.md`. It lands in three PRs: first the store and rules, then the MCP door and the web page in parallel. Tools live in their own `link_tools` table, and nothing is written on an opening. A tool's writes and Undo apply only while its row still holds the values they read, compared by value. Shelf tools never opened sort by when they were kept, newest first. The digest's still-using check is judged again once claimed, so a tool opened or answered since selection drops out but stays marked.
  - **Keep handy over MCP (#125).** `save_link` and `update_link` take `handy: {action, source}`, with action `keep`, `still_using` or `not_handy`. `update_link` applies it before the other fields, after checking the tags, so a refused `handy` changes nothing. A new save whose `handy` is refused keeps the link and says so with its id, and a repeat save ignores `handy`. Each of `save_link`, `update_link` and `get_digest` reads the clock once, so an opening sent with an answer lands at the answer's instant, and a digest item's `handy` uses its claim's instant. The composition stays in the door. Every link result carries `handy`. `get_digest`'s still-using check comes last and takes one of the five slots; a check that is no longer due once claimed frees its slot, and claiming it before select is accepted. `previewDigest`, and so Worth a look, holds reading picks only; due tools belong on the Handy shelf, which #125's web PR builds.
  - **Keep handy on the web page (PR 3).** Owner rulings, 2026-10-16:
    - The shelf is a grid of about four tiles per line on wide screens, and one sideways row below 600 px.
    - Due tools come first on the shelf. This is core's `listShelf` order, so a tile asking "Still using?" is behind Show all only when more than 8 are due.
    - At most 2 suggestion tiles show, newest first, after the kept tools and outside the 8.
    - The page sends `asked` for Still using, and core keeps the row's existing source. Keep handy and Not handy anymore send `stated`.
    - After a shelf refresh, focus goes back where it was, or else to the next tile or the heading.
    - A refresh that answers after a newer one began is dropped.

    Choices accepted with them:
    - Add goes to the search page, whose results carry Keep handy.
    - Suggestions come last.
    - Archived links and done views get no control.
    - Refusals use the page's own wording.
    - The shelf refreshes by re-reading `GET /`.
    - Undo comes with removals and with Done.
    - The tile menu is a native `<details>`.
  - **Keep handy follow-ups (#140).** Owner rulings, 2026-10-16 and 2026-10-17 (#140 comments): Worth a look leaves out the suggestions the shelf shows (up to two, newest first, a cap that lives in core), before it picks, so they use up no focus match; any other suggestion is an ordinary link there, and `get_digest` still includes every suggestion. The ⋯ menu is lined up in the bottom-right of every shelf tile.
  - **The Handy shelf's tiles are postcards (#144).** The owner chose the postcard design from three options. Owner rulings, 2026-10-17 (#144 comments 6234614437, 6234962721 and 6235422367):
    - Square cards, 176 px on desktop and 156 px on a phone.
    - The saved picture fills the card. Without one, the card shows the space's colour and the title's initials, with dark text and no fade.
    - The title runs to 3 lines, with the space dot and the site's host under it.
    - The whole card opens the link.
    - Still using? and Keep handy? sit in a panel at the top, with 44 px buttons.
    - The ⋯ menu is in the top-right corner. This replaces the #140 entry's bottom-right and the 2026-10-16 spec's "styled like home's small cards".
  - **Openings are recorded from every web page (#124),** storing only the last one. This replaces the 2026-10-14 `list_links` entry's "clicks on All links and search results are not recorded". Search, All links and space pages post `/links/opened`, which sets only `lastOpenedAt`: a click the app didn't suggest doesn't mark the link surfaced, so only home's cards claim it (#124 comment 6225313667). Clicks the app can't see, such as browser bookmarks, stay unrecorded; an AI-chat click through a redirect link is #133, and pairing web searches with the search log is #134.

- **2026-10-14:** Phase 4 is done, and the repo is public.
  - **The web page shipped** across #92–#99 and #37. #12, the phase's headline issue, closes with this entry.
  - **Secrets review (#100):** file history, every issue, PR, comment and release, and edit histories. Five comments that named the dev Mac's tailnet address or the local username were reposted with those details removed, and the originals deleted (#100 comment 6183768272). Owner's ruling: the author email in the commits stays public, since PR refs keep the old commits.
  - **Public since 2026-10-14,** by the owner's go-ahead.
  - **Outgoing User-Agent** names the deployed version, which MCP also reports (#117).

- **2026-10-14:** Versions and the list of changes (#115; design in its comments 6181038307 and 6181186661, the second winning).
  - **One date version per deployed commit,** `vYYYY.MM.DD` with `.2`, `.3` for later deploys that day. GitHub's tags are the only place names live: `deploy/release.sh next` picks the name from them on a machine where `gh` is signed in, and a commit already tagged keeps its name. The server never needs GitHub.
  - **The release list is the changelog.** `deploy/release.sh publish` tags the commit, then makes a GitHub release with generated notes. It runs only after `deploy.sh` exits 0, so a failed or rolled-back deploy is never tagged. There is no `CHANGELOG.md`. Deploys before this one are not tagged.
  - **The server reports the version.** `deploy.sh <ref> [version]` writes the release's `VERSION` file before it stops anything; the server reads it at start (`dev` when missing) and MCP sends it as `serverInfo.version`. A rollback runs the previous release with its own file; a release built before this still reports `0.1.0`.

- **2026-10-14:** Browse the whole library: `list_links` and All links (#37). Owner rulings, in session, and the sources in `docs/specs/2026-10-14-list-links-sources.md`:
  - **A new read-only tool, `list_links`.** It returns `{links, total, nextCursor}`; `search_links` keeps its input and output, and its description points to `list_links`. MCP's cursor pagination covers list operations such as `tools/list`, not tool results (the 2026-07-28 Pagination page), so the cursor is an argument and a result field, as the Tools page's "Stateful Tools" guidance describes. A cursor that doesn't fit is an `isError` result, not the -32602 that page gives list operations.
  - **The total goes to AIs only.** The page designs put no totals anywhere (#12 comment 6158134489), so the web shows no count. `total` counts the links that pass the filters in that order, all pages together, in a separate read from the page.
  - **Three orders,** on both the tool and the page: newest first, oldest first, and recently opened. Recently opened lists only links with a recorded opening (home's cards or an AI's `opened: true`); clicks on All links and search results are not recorded, which is a separate decision. Cursors carry their order: newest is unprefixed, so space-page links stay valid; oldest is `o`, opened is `r`. A newest or oldest cursor must name one of the owner's links at its save time. An opened cursor must name a link whose last opening is at or after the cursor's time: openings only move forward, so reopening the cursor's link keeps the walk going. A link first opened during an opened walk moves ahead of the cursor and is missed until the AI lists again; the tool's description says so.
  - **Counting.** `LinkCount` is a separate interface from `LinkSearch`. `FtsSearch` implements it with `COUNT(*)` over `scope()` and the same order table its listing uses, and `FakeSearch` mirrors it. `createDeps` wires `count` to the keyword search, and `McpDeps` gains it. The web door reads pages only and never counts.
  - **All links** (`/all`, `/all/done`) lists every link, tagged or not, 24 a page, grouped by the UTC month of the order's time, with the year when it isn't this one. Each month section carries `data-month`, and Show older links (one script shared with space pages) joins a continuing month by that key, never by its heading. Cards show the picture or a tint, the title, and the space and site; done cards are faded. An order chooser under the heading, which the artboard doesn't have, provides the three orders. An unknown order or a changed cursor gets a 400. All links leads the menu.
  - **Hand-off:** links can't be deleted yet, so a cursor never names a deleted link. Whatever adds deletion must decide what such a cursor does.

- **2026-10-14:** "Worth a look today" joined to Your spaces (#95, after #96 merged).
  - **Space colors.** Each card takes its link's `linkSpace` color, so one with no colored pinned tag stays neutral. `homeSpaces` now returns the owner's catalog with the spaces, so `GET /` loads the tags once for both.
  - **Tell me why on space cards.** An active space card with no why asks Tell me why, the same control and script as home (`src/web/tell-why.ts`), posting `/home/why`; it replaces the amber "No why yet" pill. Done cards keep their neutral "No why yet" with no control.

- **2026-10-14:** "Worth a look today" on the home page (#95; plan in comments 6174150207 and 6174529271, the second winning). Owner rulings, in session:
  - **Picks.** Up to three cards from the digest's whole queue (`previewDigest`, which marks nothing), so `GET /` writes nothing: the session cookie is SameSite=Lax, so a cross-site GET could otherwise use links up. **A focus match leads** (comment 6176064419): the queue's first link matching a focus entry, in digest order, is the large card. The other cards, or all three when nothing matches, come from a shuffle of the rest of the queue by link id, new each UTC day, so a card going away or a link being saved moves no other pick. When the lead goes, the next focus match leads, or else the shuffle's first.
  - **Open it** (or a title) is a real link in a new tab; a click or middle click also posts `/home/opened`, which records the opening and marks the link surfaced through the digest's one claim path, so home leaves it out for two weeks. It never writes the search log. An opening from the browser's context menu is not recorded (accepted).
  - **Not now** marks the link surfaced and snoozes it for two weeks (`SNOOZE_MS`). **I'm done with it** archives it. Not now on a link already snoozed into the future or archived, and I'm done on one already archived, answer 409 with nothing written, so a stale card can't override an AI's snooze or archive (comment 6177571525). Large and small cards both have them; small cards show them as text buttons.
  - **Undo is conditional.** Undo of Not now fully restores the link (comment 6177571525): `/home/snooze` answers 200 with `{until, claimedAt, previousSurfacedAt}`, and `/home/unsnooze` sends them back (the plan said 204; the page needs the values). It clears the snooze only while it is still the one Not now set, and takes back Not now's surfaced claim, restoring the previous `lastSurfacedAt`, only while no later claim replaced it (`unclaimSurfaced` in `core/digest.ts`, through `LinkStore.unclaimSurfaced`). Each part is conditional on its own; a changed snooze answers 409. Undo of I'm done makes the link active only while it is still archived. Otherwise Undo answers 409 and the card stays gone. Both use a new conditional store write, `LinkStore.updateIf`.
  - **Tell me why** saves the owner's answer as `asked`, replacing a missing or inferred why only; over a stated or asked one it answers 409. Blank text is refused.
  - **Reason copy.** A focus entry the owner gave reads `You said you're working on "…"`; an inferred one reads `Maybe you're working on "…" (a guess)`. A link not opened lately reads "You saved this over a month ago"; otherwise "You saved this {date}". Amber is used only for the needs-you card and its Tell me why.
  - **Not in this change:** space colors on cards (#96 brings `linkSpace`; until then every card is neutral), the spaces section (#96 fills `homePage`'s `spaces`), and a time limit on Undo of I'm done, which would need a stored archive time.

- **2026-10-14:** Your spaces (#96; plan in comment 6174151207, revised by comment 6174529645).
  - **Owner ruling: a space shows only active links.** Done (archived) links are left out of its mosaic and list. They are shown faded but legible under "Links you're done with", at its own path, `/spaces/done?tag=`.
  - **A link's color** is `linkSpace` (`core/link-space.ts`):
    - `within` wins when it names one of the link's pinned tags;
    - otherwise the link's first pinned tag in attach order;
    - a pinned tag whose stored color is not in `SPACE_COLORS` is skipped;
    - null is neutral, so amber never appears.

    Search results and space cards read it. #95's cards read it once #95 and #96 are both merged.
  - **Space pages.** Every tag the owner has gets a space page, pinned or not. Only pinned tags show on home, by key. The band uses the tag's color when it is a space color, otherwise neutral. A blank or missing `tag` redirects with 303 to `/`. An unknown key and another owner's key get the same 404, which never names the key.
  - **Paging.** `newestLinks` (`core/link-pages.ts`) pages newest first by `(savedAt, id)`, 24 links a page on the web. `SearchFilters.before` applies to a blank query only, and a word query with it is refused. The cursor is opaque to the door. Core accepts one only when it names one of the owner's links with that saved time, so a hand-made id never reaches the engine; anything else is `invalid_input`, which is a 400. "Show older links" is a real link, and a script appends the next page, navigating instead when the answer was redirected or failed.
  - **Mosaic.** It shows the stored images of the 3 newest active links that have one, among the space's newest 50 active links. Cells without an image are tints of the space's color.
  - **Origin check.** `/`, `/spaces` and `/spaces/done` join `CHECKED_PAGES`, since home now shows owner data. This is the same change as #95's.
  - **Open question, not yet decided:** an unpinned tag that kept its color gets a colored band, while its cards fall back to their first pinned tag, since `within` counts only pinned tags.

- **2026-10-14:** The Tags page (#97; plan in comment 6173556769, revised by comments 6173827375, 6173935487 and 6174590317).
  - **Owner rulings (comment 6173827375).**
    - **Only an inferred project is a guess.** It reads "Project? (a guess)" until the owner confirms it; a topic always shows plainly, since every tag starts as one. This narrows spec §5's "Inferred values are always shown as guesses" for tag kinds.
    - **Colors are shared when needed.** There is no cap on spaces; past six colored tags, two spaces may share a color.
    - **Unpinning shows the Undo bar.** Undo pins the tag again, with the color it kept.
  - **Project status on the web (owner request, comment 6173935487).** This amends the 2026-10-13 page design, whose Tags edit panel held only kind and color (#12 comment 6158134489, item 2). `setProjectStatus` marks a project done or reopens it and refuses a topic; marking done shows the Undo bar.
  - **The color rule (comment 6173827375).** A new pin takes the first color no tag holds, then the first no pinned tag holds, then teal. The pin fills the color in the same write (`COALESCE`), so a color chosen meanwhile is kept, and unpinning keeps it. A pinned tag always has a color: `pinTag` is the only write of `pinned`, and no write clears a color.
  - **Implementation.**
    - Pin and color are store methods (`pinTag`, `colorTag`) rather than `updateTag` fields, since a `COALESCE` pin cannot be a patch field.
    - From #99's review (comment 6174590317), `showUndo` moves focus to Undo, and the bar stays while it has focus or the pointer, up to 45 s after it was shown (`UNDO_BAR_MAX_MS`), inside the 60 s server undo windows. When it closes, focus goes back to what had it. The web door reads a JSON body as one checked object (`jsonBody`), the Profile page's routes included.
- **2026-10-14:** The Profile page (#98; plan in comment 6173556256, revised by comment 6173758666).
  - **Labels.** A note written on the web shows "You confirmed this". An inferred note or focus entry shows as a guess by the AI that wrote it.
  - **Undo acts now** (the #99 ruling, comment 6173113093). Remove is done at once and Undo restores the note, unchanged, within 60 seconds (`NOTE_UNDO_WINDOW_MS` in `core/profile.ts`).
  - **Removal is soft.** This holds for `edit_profile` too. A removed note is hidden from every reader at once: `get_profile`, `save_link`'s profile and the page. Its row is deleted at that owner's next profile write after the 60 seconds; there is no timer.
  - **Stale pages are refused.** The page's Edit, That's right and Remove send the version the page showed. If an AI changed the note since, the change is refused ("An AI changed this note. Reload.") and the note is unchanged.
  - **"web" is reserved for every writer.** An OAuth app whose name is "web" in any case, after trimming, is recorded by its client id, so it can't pass for the owner. Agent keys already refused the name. No production key was named "web" (comment 6173760638).
- **2026-10-14:** The server keeps its own copy of each link's preview image (#94; plan in comments 6171805935 and 6173115474, the second winning).
  - **Owner ruling: images are cached, and wiped on sign-out.** `/images/:id?v=<sha256 prefix>` answers `Cache-Control: private, max-age=31536000, immutable` when `v` is the stored image's version; any other answer, and every 404, is `no-store`. Sign-out answers `Clear-Site-Data: "cache"`; that a real browser honours it on the sign-out `fetch` has not been checked. This is the one exception to the web door's `no-store` rule.
  - **A separate image pass** (`core/image-indexer.ts`) sweeps every 15 s, one fetch at a time, beside the vector indexer, so a save never waits for an image. A snapshot recorded with an image URL is `pending` (migration 10 backfills every stored image URL). Writes compare and set on `pending` for the same URL, so a late result cannot replace a stored image.
  - **Retries.** A network error, timeout, 408, 429 or 5xx retries after 1 min, doubling up to 1 h, and ends as `none` on the fifth failure. A refusal by the address rules ends as `refused`; a non-image, a body over 2 MB, a header over 40 megapixels or another 4xx ends as `none` at once. Backoffs are kept in memory, so a restart tries every pending image again. A shutdown abort leaves the image `pending`.
  - **Types.** The magic bytes decide (PNG, JPEG, GIF, WebP); SVG and AVIF are refused. An upstream `image/*`, `application/octet-stream` or `binary/octet-stream` is read.
  - **One rule set.** The page and image fetchers share `fetch/guarded-request.ts`. The JSON fetcher for OAuth metadata, which never follows redirects, keeps its own.
  - **Not in this change:** a space-color fallback for a card with no image (#96, #97), images in MCP output, re-fetching when a page changes.
- **2026-10-14:** Agent keys on the Apps and keys page (#99; plan in comment 6171805481, revised by comment 6173113093). Owner rulings, in session:
  - **Web creation.** The signed-in owner can make a key on the page, with no re-entered password and from any network.
  - **Names.** A name is at most 60 characters, and "web" in any case is refused, after trimming. Both rules live in `createAgentKey`, so they hold for the CLI too.
  - **Undo acts now.** Turning off is done at once, by key id, and Undo turns the key back on within 60 seconds unless a key with the same name was made since. This applies to later Undo bars too; Disconnect keeps its own flow for now.
  - **Wording.** Keys are "turned off", not "revoked"; the CLI's `revoke` subcommand keeps its name.
- **2026-10-14:** Every app the owner allows gets a refresh token (#102, comments 6169832338 and 6170186544). ChatGPT asked for `links` only, so it had to reconnect every hour.
  - **The server adds `offline_access`.** The MCP spec says servers "SHOULD NOT include `offline_access` in `WWW-Authenticate` scope or Protected Resource Metadata `scopes_supported`" and that "the AS retains discretion". So `src/auth/offline-access.ts` adds it to an authorize request's one `scope` when it is missing; better-auth decides the rest.
  - **Refreshes too.** A refresh asking for less would get a successor token that never rotates (#105), so the same rule applies to refresh requests.
  - **Edge cases.** At authorize, a missing, empty or repeated `scope` is left for better-auth to answer. At the token endpoint it is added in a better-auth before hook, to the scope better-auth parsed, so the two can't read a request differently. The consent page says the app stays connected until it is disconnected.
- **2026-10-14:** The web search page (#93; rulings in comments [6170507254](https://github.com/Nostoi/aye-ai-ai-links/issues/93#issuecomment-6170507254) and [6170580076](https://github.com/Nostoi/aye-ai-ai-links/issues/93#issuecomment-6170580076)). Web searches are not logged until the page records which link is opened, so `search_log` holds agent searches only. A blank search lists the newest links. A saved link opens in a new tab (`src/web/AGENTS.md`). The menu shows only pages that exist.
- **2026-10-14:** The public address moves from Tailscale Funnel to a Cloudflare Tunnel on the owner's domain (#102; comments 6159690488, 6168949364 and 6169170865).
  - **Why.** ChatGPT's servers got a 502 through the Funnel address, and the app recorded no request from them; a request from ChatGPT through a Cloudflare tunnel reached the app.
  - **Tailnet.** Tailscale Serve stays for agent keys.
  - **One sign-in limit** (owner ruling, in session). This replaces the 2026-10-13 tailnet login bucket. Cloudflare passes a client-sent `Tailscale-User-Login` through unchanged, so anyone could have claimed that bucket. The lockout risk from a shared limit is accepted; restarting the server resets the count.
  - **Rollback.** Before rolling the server back past this change, take the Cloudflare host out of `AYE_ALLOWED_HOSTS`.

- **2026-10-13:** Phase 4 page designs and owner rulings (#12 comment 6158134489). The reason a card is shown uses its space's color, not amber, which changes the layout-A mockup. Removing or turning something off shows an Undo bar instead of asking first. Sign out is in the menu on every page. Page images are kept by the server (#94).

- **2026-10-13:** Claude and ChatGPT are connected through OAuth and work on the web, the desktop app and the phone (#79 comments 6156007913 and 6156149494). Both identify by CIMD. ChatGPT did not ask the owner to confirm changes, so spec §5's "ChatGPT asks the user to confirm each write" does not hold, and spec §11's `readOnlyHint` row is settled: the app's own rules in `core/` stay the safeguard. Owner rulings: the shared authorize limit is accepted (comment 6156177323), and the tailnet login bucket covers devices signed in as the owner (comment 6155704870). The README's setup now uses the 443 address for everything.
- **2026-10-13:** Going public (#79). Owner rulings (comment 6153394817): consent stays unbound to the session that started authorize while there is one login (Q1); a visited page filling the pending-connection slots is accepted (A3); a removed key working up to about 7.5 min is accepted (A1). Funnel is on for 443 only (comment 6154913657). The forged-header probe showed Funnel strips `Tailscale-User-*` and sets `Tailscale-Funnel-Request` (comment 6154988441), so tailnet sign-ins get their own login bucket, per the 2026-10-12 ruling.
- **2026-10-13:** Rules about who may call and as whom live in `src/auth/`, not `core/` (owner rulings, #77 comments 6146659143 and 6147438487, after the B2 architecture review): the web login, agent keys, app connections and their tokens, and the recorded `savedBy`. AGENTS.md's "Doors hold no rules" names the exception. Which `next` page sign-in returns to is decided in `src/auth/login-return.ts`, moved there from the login page's script (comment 6146659143).
- **2026-10-13:** Disconnecting an app, and the OAuth error page (#77 PR B2; plan in comment 6144294913, amended by comment 6144293276).
  - **Disconnect is web-only.** The signed-in page `/connections` lists the owner's apps; Disconnect deletes, under the auth lock and in one transaction, the owner's access tokens, refresh tokens, consent and unused authorization codes for that app. It answers 204 whether or not the app was connected. There is no CLI channel.
  - **The client row stays.** Deleting it would cascade to other users' grants and drop a DCR app's registration. A DCR client left with no consent is deleted by the startup prune once it is a day old; CIMD rows are never pruned, and admission refuses a CIMD client once its snapshot is gone.
  - **Condition 11, with generations.** A refresh fetches outside the lock and applies its result in one lock section. It publishes only if the client was not forgotten since the refresh began (a per-client generation that disconnect bumps) and is pinned or connected in the database at that moment. A late 404 from before a disconnect cannot erase a newer snapshot. A rejected result is `dropped`, which brings no 30 s retry.
  - **Shared snapshots.** Grants are deleted for the one owner; the snapshot, pin and connected entry are forgotten only when, under the same lock, no other user still has the app connected.
  - **Accepted:** an authorize already past its connected check when a disconnect lands can still create a pending pin and a consent page; the owner must approve it again, so no credential comes back.
  - **The OAuth error page.** `/oauth-error` is served without a session and shows only our own sentence for a known OAuth error code, or a generic one; never the raw `error` or `error_description`, which anyone can put in a link. better-auth's authorize errors reach it through `onAPIError.errorURL`; the authorize gate sends the owner there when a new CIMD client's document gives no current snapshot, where admission would answer a JSON 400.

- **2026-10-13:** OAuth on `/mcp` (#77 PR B1; plan in comment 6139382870, revised by comment 6139605151).
  - **Client admission.** cimd's client discovery is wrapped (`src/auth/client-admission.ts`) and contributed through the app's own plugin. A URL client id reaches cimd only while the metadata stash holds a current snapshot for it; any other is refused with `invalid_client` before cimd counts or fetches anything. cimd's own fetch limits are raised so they never bind.
  - **The metadata stash** (`src/auth/metadata-stash.ts`) holds, per client, the document and the `jwks_uri` it names, fetched together outside the auth lock and published as one unit. cimd's transport answers from memory only, with `Cache-Control: no-cache`, so cimd re-reads it on every resolution and the stored key-set URL always matches the current document. A refresher re-reads every connected client every 2.5 min with conditional requests (30 s after a cycle in which a refresh failed; comment 6141218040), and fills the stash before the server listens. A 404, 410 or invalid document drops the snapshot at once; other failures keep it until it is no longer current.
  - **F = 5 min (owner ruling, 2026-10-13).** A snapshot is current for 5 minutes after its last successful fetch. This departs from condition 9 of `docs/specs/2026-10-12-auth-library-sources.md` (freshness from the document's own caching headers): a withdrawn or unreachable document stops working within 5 minutes, whatever it says about caching.
  - **Accepted bound (comment 6140715192):** a key removed from an unchanged `jwks_uri` keeps verifying for up to F/2 plus better-auth's 300 s key-set cache, about 7.5 minutes; a changed `jwks_uri` or a withdrawn document is unaffected.
  - **New connections.** An authorize for a client that is not connected and carries no owner session is redirected to `/login?next=`. With the owner's session, a new CIMD client's snapshot is fetched outside the lock and pinned for 10 minutes, the signed query's lifetime; at most 5 wait at once, and another is refused rather than evicting one.
  - **`client_credentials` is off.** Grant types are `authorization_code` and `refresh_token` only.
  - **Limits.** Register: 20 an hour, a 16 KiB body, and no `jwks_uri` (a DCR client's key set would be fetched outside the stash). Authorize 300, token 600 and revoke 300 a minute, global and set high: they bound database growth and are not a security boundary. The owner-lockout risk from shared limits joins #79. Unconsented DCR clients older than a day are deleted at start.
  - **The internal client.** `/mcp` introspects tokens in-process through a client with the fixed id `aye-introspect`, whose secret is regenerated on every start and held only in memory. It has no grant types and no redirect URIs.
  - **Accepted tokens** are active, `Bearer` (a DPoP-bound token, with `cnf`, is refused), for the exact `/mcp` resource, with the `links` scope. The `/mcp` rate limit is keyed by `client_id` for OAuth apps, and by owner and agent for agent keys. A link records the app's registered name, or its `client_id` when it has none.
  - **Agent keys stay** next to OAuth, the deliberate departure recorded on 2026-10-12.
  - **Deploy rollback.** A restored auth backup now also loses its OAuth tokens, consents and unused authorization codes, from whichever of those tables it has, so a rollback cannot bring back an app the owner disconnected.
  - **ChatGPT's document and key-set sizes** are checked when it first connects (#79). A document over cimd's 5 KB cap fails closed.

- **2026-10-12:** Web login for the owner (#76; comments 6137957312 and 6138128752).
  - **The `owner` CLI changes the login only while the server is stopped.** The server holds the auth file with `locking_mode=EXCLUSIVE` for its whole life, so the CLI cannot open it while the server runs; it then changes nothing and says to stop the server. A password reset racing an in-flight sign-in or password change could otherwise lose.
  - **Only three auth routes are served:** `POST /api/auth/sign-in/email`, `POST /api/auth/sign-out` and `GET /api/auth/get-session`. Every other `/api/auth/*` path gets 404 before it reaches better-auth, so `/sign-in/email` is the only route that checks a password. #77 adds the OAuth routes to the list (`AUTH_ROUTES` in `src/auth/http.ts`).
  - **Our own global login limit**, 10 sign-in attempts per 15 minutes for everyone together, and better-auth's limiter turned off. better-auth's is on only when `NODE_ENV=production` and keys on a client-sent `X-Forwarded-For`, so rotating that header gets past it.
  - **A deploy rollback that restores the auth backup deletes every session**, so the owner signs in again. Without that, a restored file would bring back sessions signed out since the backup.
  - **Lockout risk.** Anyone who can reach the sign-in route can use up the global limit and keep the owner out. Until Funnel is on, only tailnet devices can reach it. Tracked on #79, to settle before Funnel goes on.

- **2026-10-12:** Phase 3 auth uses better-auth 1.7.7, pinned exactly, with its `mcp` and `cimd` plugins (#75). Rulings: #11 comment 6134986546 and #75 comments 6136036644 and 6136212307. Sources: `docs/specs/2026-10-12-auth-library-sources.md`.
  - **Agent keys stay** next to OAuth, for Claude Code, Codex and Claude Desktop. This deliberately departs from the MCP spec's "MUST NOT accept or transit any other tokens".
  - **Revoking an app works on the next request**, as it does for agent keys. Access tokens are opaque, one lock in the server process serializes every auth request and every server-side token, code or consent write, and disconnect runs inside the server and deletes the app's tokens, consent and unused codes in one transaction.
  - **Auth lives in its own SQLite file.** Sign-up is closed, and the CLI creates the owner with id `owner`.
  - **Accepted risk:** a database write failing partway through invalidating a stolen refresh token's family leaves its successor working (better-auth #11629).
  - **Real-client tests wait for the isolation tests (#78).** "No Funnel before auth" holds with no new exception.

- **2026-10-12:** ChatGPT spike done (#9; results in its comments 6133666210 and 6133682051). Phase 3 is now current. Phase 2's features are done (#10 closed, comment 6131333429); #68 stays open in Phase 2 until the search log has enough real searches.
  - **Port 443 only.** A custom MCP plugin on a Funnel address at port 10000 was never contacted ("Couldn't reach the MCP server", with no request in the server log). The same server on 443 was added at once. OpenAI's docs do not state this, and 8443 was not tried. Claude's backend connects only on 443 (anthropics/claude-ai-mcp #125), so 443 is needed whatever ChatGPT accepts. Phase 3 must serve the app on 443 before Funnel goes on. This Mac's 443 is used by another tailnet service today, so giving it up or using another node or hostname is an owner decision for #11.
  - **Answers.** A Business workspace can add a no-auth plugin with a write tool (chatgpt.com/plugins → + → Add custom MCP server). It works in the iPhone app. ChatGPT speaks MCP 2026-07-28 and opens with `server/discover`.
  - **No confirmations.** Neither the read-only tool nor the write tool asked the owner to confirm, on the web or the phone, so the effect of `readOnlyHint` could not be seen. The toy's write tool was `destructiveHint: false` in a draft plugin; the app's destructive tools (`update_link`, `update_tag`, `edit_profile`) were not tested, so spec §5's "ChatGPT asks the user to confirm each write" is unsettled either way and #11 checks it when the app connects. The app cannot rely on ChatGPT's confirmation; the rules in `core/` stay the safeguard.
  - "No Funnel before auth" still holds for the real app; the spike's one-time exception (2026-10-10 entry) is used up.

- **2026-10-12:** Digests (#34; decisions in its comment 6128904723).
  - **Tool.** `get_digest` takes no input and returns up to 5 links, each with every reason that applies. The server picks; the calling agent writes the nudge. It is not read-only or idempotent, because each call marks what it returns as surfaced.
  - **Reasons.** `focus_words`: the link shares words with a recent focus entry, and the reason carries the whole entry (with its source). `no_why`: no why is recorded. `not_opened_recently`: saved at least 30 days ago and no opening recorded in the last 30 days; an opening is recorded only when an agent sends `opened: true`, so the agent must not say the owner never opened it. `never_surfaced`: no digest has returned it before.
  - **Eligible:** active, not snoozed at that moment (`snoozedUntil` null or not after now), and surfaced at or before now minus 14 days. That boundary is inclusive. One `now` is read per call.
  - **Order and rotation.** Up to 3 focus-matched links come first, by their newest matching entry, then by rank in it. The other slots go to every remaining eligible link with a reason (focus-matched ones not picked above included), as a fair queue (owner, comment 6129812662): least recently touched first, where touched is when it was last surfaced, or saved if never, then oldest saved, then id. Focus cannot fill the whole digest, reason kinds do not outrank each other, and a shown link returns after its cooldown however fast new links are saved; a new link can wait behind older ones.
  - **Focus is a keyword match.** Of the newest 10 focus entries (#33), those made in the last 30 days count. Each one is searched with the keyword engine alone, over all of the owner's links, and its first 3 eligible hits get its reason. These searches do not go through `search_links`, so they are not logged. A word match is not proof of relevance; the tool description tells the agent to judge it. Words are OR-ed, so a negated entry ("no longer researching batteries") and an all-stop-word entry still match; accepted until #68.
  - **Claim.** The picks are marked in one store transaction that checks each link is still eligible, and returns each link as read inside it with the value it replaced. Core judges `no_why`, `not_opened_recently` and `never_surfaced` again from that read; a link left with no reason is dropped but stays marked. Two digests at the same moment never return the same link. Stated limit: a response lost after the claim still uses up its links.
  - **Defaults (owner can change them).** Size 5, cooldown 14 days, focus window 30 days, not-opened age 30 days, 3 links per focus entry, 3 focus slots per digest: constants in `core/digest.ts`, not yet calibrated.
  - **Handoffs.** #68: switch focus matching to hybrid search once it sets the similarity floor, and retire the separate keyword wiring (`keywordSearch` in `deps.ts`) if nothing else uses it. A meaning-only hit must not be labelled `focus_words`, and hybrid search's depth cap (`min(3 × limit, 150)`) must not cut eligible matches. #12: a web view needs a preview that does not use links up; not built here. Scheduled digests stay in "Later".

- **2026-10-12:** Common words no longer count as keyword matches (#66, owner ruling; comments 6124412625 and 6126915171).
  - **List.** Lucene's 33-word English stop list (`search/stop-words.ts`), English only, no setting. A whitespace fragment is dropped only when every token in it, split the way the index tokenizer does (diacritics removed, lowercased, split on non-letters and non-digits), is a stop word. So `that/this` is dropped, `A/T` and `it's` are kept. If that drops every fragment the query is matched as typed. The owner-field match and the page match both use the result; meaning search input is unchanged.
  - **bm25 caveat.** Stop words are no longer query terms, so they add no term score, but indexed stop words still count toward document length. Accepted; nothing is rebuilt.
  - **Search log (#68).** Field and page ranks in the search log change meaning from this release: a link a filler word used to put in the field or page list may now appear only by meaning.
- **2026-10-12:** Meaning search indexes every link in the background (#32 PR D). This supersedes the C1 and C2 entries' notes that results equal keyword search until PR D. Rulings: #32 comments [6116229958](https://github.com/Nostoi/aye-ai-ai-links/issues/32#issuecomment-6116229958), [6122439969](https://github.com/Nostoi/aye-ai-ai-links/issues/32#issuecomment-6122439969), [6123827191](https://github.com/Nostoi/aye-ai-ai-links/issues/32#issuecomment-6123827191), [6124545162](https://github.com/Nostoi/aye-ai-ai-links/issues/32#issuecomment-6124545162) and [6125562145](https://github.com/Nostoi/aye-ai-ai-links/issues/32#issuecomment-6125562145).
  - **The document.** The owner's fields come first and whole: title, why and tag names, then the summary up to 1,000 code points, then the URL, so no document is empty. The page title, description and text follow and share 1,500 code points, line breaks included; only they are ever cut. The hash is the sha256 of the model key and the document, so any edit or a model change re-embeds. The model reads only the first 512 tokens, so a very long owner field or token-dense text is cut by the tokenizer. That is accepted: the 1,500 budget bounds tokenizing cost, not tokens, and the hash still sees every edit.
  - **Freshness is eventual.** The indexer sweeps every 15 s. An edit or a newly fetched page is embedded on a later sweep, and until then search uses the old vector, or none. The first start after upgrading embeds every saved link.
  - **One document per embedder call.** The model's queue is first come, first served with no priority, so a query waits behind at most one document.
  - **Failures retry with backoff:** 1 min, doubling up to 1 h, with no edit needed. A changed document is tried at once. A vector the store refuses (wrong size, not finite, length not 1) is that link's failure. Any other store error ends the sweep, is logged, and the next sweep still runs.
  - **Retirement.** At start, the indexer deletes the vectors of every other model.
  - **Query timeout.** Search waits 2 s for its query embedding, then answers with the keyword results (trace mode `fallback`). A query that expired while queued is dropped at its turn without running. The 2 s bounds waiting on async work only: it cannot interrupt an inference holding the thread, and it is not a shutdown bound.
  - **A broad change-count guard.** A sweep skips its scan when SQLite's `total_changes()` equals the count taken at the start of the last complete sweep and no failure is waiting. Any write moves it, search-log rows included, so the worst case is one full scan per poll; the scan yields to the event loop between pages of 100. It counts only the server's own connection, which is the only one that writes links. Dirty tracking waits until a measurement calls for it.
  - **Measured budget: met.** 200 documents at the cap, made token-dense (1,267 to 1,293 tokens before the 512-token cut), embedded one per call by the pinned model on the development Mac while a search ran every 250 ms. Three runs: query turnaround p50 94, 86 and 75 ms; p95 356, 129 and 99 ms; max 484, 340 and 118 ms; largest timer gap 327, 186 and 69 ms; 53 to 68 ms per document. No search fell back. The 1-minute load average was about 8 throughout, from other work on the machine, so it was not idle. The budget is a 500 ms p95, so embedding stays in the server process.

- **2026-10-12:** Searches and the link opened next are logged, to tune the similarity floor (#32 PR C2). Rulings: #32 comments [6116408707](https://github.com/Nostoi/aye-ai-ai-links/issues/32#issuecomment-6116408707), [6124184460](https://github.com/Nostoi/aye-ai-ai-links/issues/32#issuecomment-6124184460) and [6124545162](https://github.com/Nostoi/aye-ai-ai-links/issues/32#issuecomment-6124545162).
  - **What is logged.** One `search_log` row (migration 8) for each search whose trace fires, meaning a query with a searchable word. Blank queries and queries with no word are not logged. The row holds the query, filters, mode (`keyword`, `hybrid` or `fallback`), the embedded text, the model key, `meaningCandidates`, the request limit (after clamping to 1 to 50) and the links returned (id, urlKey, similarity, and the link's 1-based rank in each list that found it: owner fields, page text, meaning). Fewer results than the limit means the search was exhaustive. Ids can be reused after a delete, so the urlKey says which link a logged id meant.
  - **Pairing is a heuristic.** A `get_link` that finds its link is paired with the same agent name's latest search (highest id), only if that search has no open yet and is under 30 minutes old. A later open never overwrites it, and a link that is not found pairs nothing. Two conversations under one agent name can cross, so the tuning analysis must treat pairs as likely, not certain.
  - **Best effort.** A log failure is written to the server log and never changes a search or `get_link` result.
  - **Annotations.** `search_links` and `get_link` keep `readOnlyHint: true`: the log is internal bookkeeping, and changes nothing the owner or an agent sees.
  - **No pruning yet.** Rows are never deleted. Pruning or a cap comes with the tuning change.
  - **Trace changes (C1 follow-ups).** `SearchTrace.embedded` is documented as the text sent to the embedder. New `meaningCandidates` counts the rows the vector lookup returned. A hybrid search with 0 means no stored vector passed the filters, which includes every search before PR D.
- **2026-10-12:** Search combines keyword and meaning results (#32 PR C1). Rulings: #32 comments [6116408707](https://github.com/Nostoi/aye-ai-ai-links/issues/32#issuecomment-6116408707), [6116939105](https://github.com/Nostoi/aye-ai-ai-links/issues/32#issuecomment-6116939105) and [6124184460](https://github.com/Nostoi/aye-ai-ai-links/issues/32#issuecomment-6124184460).
  - **Your words first.** Links whose own title, summary, why or tags match come first, in keyword order. Page-text and meaning hits follow, merged by reciprocal rank fusion (k = 60) over the top `min(3 × limit, 150)` of each list, with no similarity floor yet.
  - **Keyword fallback.** If the model or the vector lookup fails, search returns the keyword results and logs the error.
  - **Start order.** The server loads the model before it opens the database, so a missing or changed model fails the start and the deploy rolls back. Any failure before listening closes everything opened so far.
  - Until PR D stores vectors, results are the same as keyword search. Common words still count as owner-field matches; #66 changes that.
- **2026-10-12:** The meaning-search model is four pinned files in a local folder, installed by the deploy (#32 PR B). Rulings: #32 comments [6116229958](https://github.com/Nostoi/aye-ai-ai-links/issues/32#issuecomment-6116229958) and [6123037594](https://github.com/Nostoi/aye-ai-ai-links/issues/32#issuecomment-6123037594).
  - **A local folder replaces cache-plus-revision.** transformers.js 4.3.1 drops the tokenizer when it loads a pinned revision from its cache offline, so the first embedding fails. With an absolute folder as the model id and remote loading off, it loads with no network access.
  - **Hashes are checked twice:** at deploy, and every time the server loads the model. A canary sentence must also embed to its recorded values (first 8 within 1e-4, 384 finite values, length near 1). The canary alone did not notice a changed `model_max_length`.
  - **One serialized queue** inside the embedder: at most one inference runs at a time across queries and documents, and a failed call does not block the next.
  - **CI sets `ONNXRUNTIME_NODE_INSTALL=skip`** on `npm ci`, so Linux CI does not download onnxruntime's CUDA build, and a CI step fails if it is there. It is an environment variable rather than an `.npmrc` key because npm warns that unknown `.npmrc` keys will become errors. The macOS build needs no CUDA files.
  - **`deploy.sh` runs the prefetch** (`dist/cli/prefetch-model-main.js`) after the build and before it stops anything, on every deploy. A failure leaves the running install unchanged.
  - **There is no `AYE_MODEL_DIR`.** The models always live in `~/.aye-links/models`, beside `releases/`, so pruning releases cannot reach them.

- **2026-10-12:** Meaning search stores its vectors in an ordinary table and uses sqlite-vec only for its distance function (#32 PR A). This narrows spec §2's "sqlite-vec". Rulings: #32 body and comment 6122439969; research: #32's first comment.
  - **`link_vectors`**, migration 7, is an ordinary table keyed by link and model. A link's vectors are deleted with it, the migration needs no extension, and the keys CLI never loads one. `vec0` virtual tables are not used: tag and project filters must apply before the top-k cut.
  - **sqlite-vec is pinned at exactly 0.1.9.** Only `vec_distance_cosine` is used, so if a pre-v1 release breaks, only that one function has to be replaced.
  - **The reader leaves out vectors it cannot score:** rows of a different size than the query, and zero, NaN or near-zero vectors.

- **2026-10-12:** `save_link` shows the fetched page, and `get_link` returns its text (#31). Rulings: #31 comment 6118791899. Sources: `docs/specs/2026-10-12-snapshot-excerpt-sources.md`.
  - **The wait lives in core.** `saveLink` races a new link's kick promise against 4 s (`SAVE_WAIT_MS`), clears the timer, and reads the link again, so the result shows the page and any edit made meanwhile. A repeat save never kicks or waits.
  - **`snapshotText: {text, truncated} | null`** is a new top-level key on `save_link` (500 code points) and `get_link` (20,000), built only in `core/snapshot-text.ts`. `Link.snapshot` still never carries the text, and search and `update_link` never read it.
  - **Text only when ok (Codex).** Text is read only when the link's own snapshot is `ok`, so a status and its text always come from one moment.
  - **`pending` means not fetched yet (Codex).** A finished job can still leave `pending` (a failed record, or shutdown). The guidance says to call `get_link` later. No new status.
  - **Inline is expected, not guaranteed (Codex).** The cap bounds the text, not the result: escaped control characters or a long title can still pass Claude Code's 50,000-character limit. The next deploy checks a long page live; the cap drops only if it goes to a file (owner, Q3).
  - **No special failure handling after the commit.** A failed read after the commit reports "try again", and a retry returns the saved link with `created: false`.

- **2026-10-12:** `update_link` can change a link's title (#57, owner request). This extends spec §5. It works like summary: leave it out to keep it, send null to clear it. It has no source label, because it is the agent's own wording, not a guess about the owner. The page's own title stays separate in the snapshot and stays searchable, so a search for an old title can still find the link through its page.
- **2026-10-11:** Page snapshots run in the background (#30, PR C: C1–C4). The C1 entry below covers the store.
  - **Runner (core).** `core/snapshot-runner.ts` runs at most 2 jobs at once, sweeps for due snapshots every 30 s, and refills a slot as soon as a job ends. A job leases its snapshot for 120 s, fetches, extracts and records. `core/snapshot-outcome.ts` maps each outcome to a status and a `lastError` of the form `<stage>:<kind>[:<detail>]`, and retries a retryable outcome after 1 min, 10 min, 1 h, 6 h and 24 h, then fails at 6 attempts.
  - **Kick only on created.** Core `saveLink` sends a new link's snapshot ahead of the backlog; a repeat save never fetches. The kick never rejects, so a background failure cannot fail a committed save. #31's excerpt wait will use the kick's promise.
  - **Shutdown order.** Stop taking work; drain HTTP (10 s); abort the jobs, which give their attempts back (a page already extracted ok is recorded), and wait for them and for running MCP tool calls (up to 5 s); close the fetcher, then the extractor; close MCP, then the database. That fits launchd's 20 s `ExitTimeOut`. A call that outlives the wait fails on the closed database, and the error is caught and logged.
  - **`save_link` is `openWorldHint: true`**, since saving now fetches the page.
  - **The first deploy fetches the backlog.** Every existing link has a pending snapshot, so the first start fetches the whole library, two pages at a time. The owner runs `deploy/deploy.sh main`; the orchestrator checks child cleanup, lease recovery and the backlog drain, and records the result on #30.

- **2026-10-11:** Profile notes and focus log (#33).
  - **Tools (owner), a change to spec §5.** `get_profile` reads. `add_profile` adds notes and focus entries and is non-destructive. `edit_profile` edits and removes notes and is destructive. Spec §5 named a single `update_profile`; the split keeps routine adds from being gated as destructive. `save_link` also returns `profile` (notes and recent focus; the active projects stay in `filingContext`).
  - **Labels (owner).** Notes and focus entries both carry a source (`stated`, `asked`, `inferred`) and the writer from the agent key. This follows AGENTS.md "Label guesses" and goes beyond spec §4, which gave focus entries no source.
  - **A stated note is protected (owner).** `edit_profile` refuses to change a `stated` note unless the new source is also `stated`, and tells the agent to add its own guess with `add_profile`. Removing a stated note needs the owner's instruction, which the tool description says; core cannot check it.
  - **Length caps (owner's defaults, can be changed).** 1,000 characters per note and 500 per focus entry. Longer text is refused, never truncated.
  - **Recent focus** is the newest 10 entries (`RECENT_FOCUS` in `core/profile.ts`). #34 owns what a digest picks from them.
  - **Ids and writes.** Note ids are never reused after a delete. A write returns the profile as it stood inside its own transaction, with the new ids, and does no second read. A failed edit or remove id changes nothing in that call.
  - **Two agents editing one note:** the last write wins, which is acceptable for a single owner. An edit or removal is written only while the note still has the source it was read with; if it moved, the call answers `conflict` and changes nothing. So an inferred edit never replaces a stated note.
  - **Older builds lock out.** The migration adds two tables (`profile_notes`, `focus_log`) and rebuilds none, but older builds refuse a database with a newer schema, as with agent keys (#6), so the server and the CLI are deployed from one build (#7, #27).
  - **Output schemas.** `get_profile`, `add_profile` and `edit_profile` each declare one in `src/mcp/output-schemas.ts`, and `save_link`'s schema includes `profile`. This supersedes the earlier "no `outputSchema`" decision (see the #39 entry).
  - Sources: `docs/specs/2026-10-11-profile-tool-sources.md`.
- **2026-10-11:** Page extraction runs in a forked child process (#30, PR B).
  - **A forked child, not a `worker_thread` (owner).** This supersedes the #29 wording. A worker can abort the whole server when it runs out of memory (Node's docs say so, and a 5 MiB page aborted it at a 256 MB limit); a child that does so is only a dead child. The child runs with `--max-old-space-size=384` and is killed with `SIGKILL` at a 20 s deadline. It is not detached, so it stays in the service's process group and launchd kills it with the service.
  - **Content failures are terminal; process failures are retried (orchestrator).** A timeout, out-of-memory or crash while parsing is not retried, and any metadata already read is kept. A child that cannot start, loses its channel, or ends for any reason before it has received the page (the child says "received" first) is a separate kind that can be retried. Out-of-memory is reported only when the child's stderr says "heap out of memory"; any other abort is a crash.
  - **Files the extraction child loads import each other with `.ts` names (owner).** `rewriteRelativeImportExtensions` makes `tsc` emit `.js` for `dist/`. These files use only TypeScript that Node can strip (no enums, namespaces or parameter properties). A test that starts the real child enforces both. Rule: `src/fetch/AGENTS.md`.
- **2026-10-11:** Lease tokens and attempts counted at lease (#30, PR C1). This supersedes the "Claim lease" bullet of the entry below.
  - **Token rule.** Migration 6 adds `snapshots.lease_token` (additive, no rebuild). `leaseSnapshot` increments it and returns the new value as the `claim`; `next_fetch_at` is still set to the lease end, so an expired lease is due again, but it is no longer the claim. `recordSnapshot` and `releaseSnapshot` write only while `lease_token = claim` and increment it in the same statement, so a claim is never valid twice, even for a retry due at the lease end or a release and re-lease in the same millisecond.
  - **Counted at lease.** `leaseSnapshot` increments `attempts` and returns the count including this attempt. The runner writes that count back unchanged.
  - **`releaseSnapshot(owner, id, claim, now)`.** Takes the counted attempt back and makes the row due at `now`, only while the claim is current and the status is `pending` or `retrying`; otherwise false and nothing changes. For a shutdown abort only.
  - **Consistency guard.** `recordSnapshot` returns false, writing nothing, when the status and `nextFetchAt` disagree: `pending` and `retrying` need a time, every other status needs null.
- **2026-10-11:** Snapshot store (#30, first of three pull requests: store and migration).
  - **Interface.** Snapshots have their own `SnapshotStore` in `core/`, like `ProfileStore`, rather than more methods on `LinkStore`. `SqliteStore` and `FakeStore` implement both. `dueSnapshots` is the one cross-owner read.
  - **Claim lease.** `leaseSnapshot` sets `next_fetch_at` to the lease end and returns `{url, attempts, claim}`, where the claim is that end time in milliseconds. `recordSnapshot` writes only while `next_fetch_at` still equals the claim, so a job that outlived its lease writes nothing once the snapshot has been leased again, and a finished snapshot cannot be written twice.
  - **Search text.** A separate `snapshot_search` index, with its own triggers on `snapshots`, holds the page's own title and description plus its extracted text (owner ruling, Q4). `link_search` is unchanged. Keyword search lists owner-field matches first, in their existing order, then links matched only by page text, so page length never lowers the owner's own matches. Existing links get a `pending` snapshot.
  - **Links.** `Link.snapshot` carries status and page fields, never the text; `getSnapshotText` reads it. `NewLink` omits `snapshot`, and saving a link creates its `pending` snapshot in the same transaction.
  - **Output schema.** `snapshot` is part of `linkOutput` (`src/mcp/output-schemas.ts`), with `status` a closed enum of the migration's values. Per the #39 entry, adding a status later is a breaking change for a validating client holding an earlier `tools/list`.
- **2026-10-11:** MCP output schemas (#39). Sources and quotes: `docs/specs/2026-10-11-output-schema-sources.md`.
  - **Every tool declares an `outputSchema`** (`src/mcp/output-schemas.ts`), with timestamps as plain strings because a valid `Date` can serialize outside four-digit ISO years. A test enumerates `tools/list`, so a tool without a schema or samples fails; it runs the advertised schemas with Ajv against real results in both protocol eras.
  - **Errors stay text-only.** An unknown tool is a JSON-RPC -32602 error.
  - **Strict in the server, open in `tools/list`.** `guarded` checks the exact shape; `tools/list` allows extra keys, so a validating client holding an earlier list still accepts a result with a field added later. #30's `snapshot` and #33's `profile` are the first added fields. Each tool states its schema once, through `register` in `server.ts`.
  - **Adding an enum value is still a breaking change:** a validating client holding an earlier list refuses the new value. #30's snapshot statuses are the first case.
  - **A result that breaks its schema after a write** is logged, and the agent is told the change was saved and not to retry.
  - **#33:** its tools are `get_profile`, `add_profile` and `edit_profile`; each declares a schema from these exports, and its "no `outputSchema`" decision is superseded.
- **2026-10-11:** Phase 1 done; deploy hardening (#27).
  - **Phase 1 done.** Claude Code and Codex both save, search and get links through `https://<mac>.ts.net:8444/mcp` with their own keys. Neither sends a foreign Origin, and both work with the stateless 2025 serving. The evidence is #7's closing comment.
  - **Stopping waits.** Real `launchctl bootout` returns before the process exits, so `deploy.sh` now waits for every process using `aye.env` to stop before the backup, a restore or a start. If one will not stop within 25 s, or `pgrep` fails, nothing is started (#27).
  - **Automatic rollback.** From the old service being told to stop until the new release is listening, any interruption, and after the stop is confirmed any failure, stops the new release and starts the previous one again (before the switch, only if its plist is installed); an interruption after the new release is listening leaves it running; with no previous release it removes `current` and the plist and leaves the service stopped. If the schema changed or there was no database before, the failed release's database, with its writes, moves to `data/backups/failed-*.db` (not merged back) and this deploy's backup, if any, is restored; otherwise the live database and its writes stay. If a rollback step fails, the service is stopped (or reported as unconfirmed), the plist moves to `~/.aye-links/com.aye-links.plist.disabled` so login cannot start it, and `~/.aye-links/recovery-pending` records what happened; deploys refuse to run until the owner fixes things and deletes it.
  - **Pruning.** After a good deploy only the `current` and previous releases and the 10 newest backups are kept; `failed-*` files are never removed.
- **2026-10-12:** A tag's kind carries its source (#45; decisions in its comment 6127485241). This supersedes the #23 entry's "No migration" line and its "asking for the kind a tag already has changes nothing".
  - **Column.** Migration 9 adds `tags.kind_source` (stated, asked, inferred). Tags that already exist get `inferred` from the column default; their origin was not recorded, so they are shown as a guess.
  - **Creation.** Core computes `kindSource` per normalized tag: the winning mention's source when that mention gave a kind, otherwise `inferred` (nobody stated it). The winner is still chosen as in #5. The store writes it only when it inserts a new tag.
  - **No automatic upgrade.** A later mention never changes an existing tag's `kindSource`: a copied tag carries its attachment's source, not evidence about the kind.
  - **Confirming.** `update_tag` sets `stated`. A change of kind writes kind and source and clears done, as before. The same kind with a source other than stated writes only the source, guarded on the kind, so done stays done. The same kind already stated writes nothing.
  - **Reads.** `Tag.kindSource` and `LinkTag.kindSource` always come from the catalog, so a confirmation shows on every link already carrying the tag. Both output schemas gain `kindSource`; `tools/list` stays open to added fields (#39).
  - **Guidance.** The shared instructions, `save_link` and `get_profile` tell agents to present a project whose `kindSource` is `inferred` as a guess (`asked` counts as the owner's word, as the spec's guess rule has it) and to call `update_tag` only when the owner confirms or changes it. The shared instructions, `save_link` and the tag `kind` field on `save_link` and `update_link` say a new tag's source also labels its kind, so send a kind with `stated` or `asked` only when the owner gave it (#45 comment 6127813244).
- **2026-10-11:** Change a tag's kind (#23). This supersedes the MCP door (#5) entry's "will come" line.
  - **Tool.** `update_tag {name, kind}` changes an existing tag between topic and project and returns `{tag}`. It never creates a tag. The description tells agents to use it only when the owner says so. Hints, wording and sources: `docs/specs/2026-10-11-update-tag-sources.md`.
  - **Rule.** It lives in `core/tag-kind.ts`, so phase 4's web tag management (#12) can call it. Names match like all tags (ignoring case and extra spaces), and the tag keeps its first casing.
  - **Project status.** Any change of kind clears "done". Changing a project to a topic and back therefore reopens it; the tool has no status argument, and the description says so. Asking for the kind a tag already has changes nothing. Setting or reopening status is #12's, and it must go through a core rule that refuses a status on a topic.
  - **Races.** The store writes only while the kind is still the one core read (`updateTag(owner, key, patch, expectedKind)`). If it moved, core reads once more and applies the rule again; a second miss is a `conflict` error.
  - **Freshness.** Calls that start after `update_tag` returns see the new kind. A search that ranked its results before the change can still return the old kind, the limit already accepted in the keyword search (#4) entry.
  - **No migration.** The `tags` columns already existed. There is still no source stored for a tag's kind, so a kind set by an inferred `save_link` mention is not labelled as a guess; that is an owner decision, not made here.
- **2026-10-11:** Tailnet service (#7).
  - **Shape.** A per-user LaunchAgent (`com.aye-links`) runs `dist/server.js` on `127.0.0.1:3002`, and `tailscale serve --https=8444` publishes it on the tailnet. It runs while the account is logged in; sleep settings are the owner's.
  - **Deploys.** `deploy/deploy.sh <ref>` builds and tests each commit in `~/.aye-links/releases/<sha>`. Only on success does it stop the service, back up the database, switch the `~/.aye-links/current` symlink and bootstrap the plist again. A failed build leaves the running install untouched. The key CLI runs from `current`, so one build serves both.
  - **Rate limit.** 120 requests a minute per identified caller (`owner/agent`); a request without a valid key is not limited and always gets 401. It runs inside the `/mcp` mount, after the Host and Origin checks and after the key check, so an exhausted bucket never hides a 403, and failed key guesses cannot use up an agent's allowance. Over the limit gets 429 with `Retry-After` and JSON-RPC code -32000. MCP 2026-07-28 `schema.ts` ("MCP error codes") leaves -32000 to -32019 to implementations and keeps -32002 reserved for resource not found. The SDK uses -32000 for its own HTTP rejections.
  - **Shutdown.** On SIGTERM or SIGINT the server stops accepting connections, waits up to 10 s for in-flight requests, then closes the MCP handler and the database. The plist's `ExitTimeOut` is 20 s.

- **2026-10-11:** Agent keys (#6).
  - **Keys.** A key is `aak_` plus 32 random bytes. Only its SHA-256 digest is stored (migration 3, `agent_keys`), and each owner and agent has one live key.
  - **Each request looks its key up again**, so a revoked key is refused from the next request that starts after the revocation.
  - **Where the code lives.** Key storage is in `store/key-store.ts`, owner-scoped except for the lookup by hash. Generation, hashing and bearer parsing are in `auth/`.
  - **Owner record.** Creating a key creates its owner. The default owner id is `owner`, and phase 3's login must link the logged-in user to it, or the existing links won't show (#11).
  - **The CLI** (`npm run keys -- create|list|revoke`) runs from a `tsc` build in `dist/`. A failed build writes nothing.
  - **Older builds lock out.** After migration 3, older builds refuse the database, so the server and the CLI are deployed from one build (#7).
  - **MCP authorization.** Static keys depart from the MCP authorization spec's SHOULD for HTTP servers. Phase 3 decides whether agent keys become OAuth tokens or stay a separate path.

- **2026-10-11:** MCP door (#5).
  - **`save_link` returns the owner's existing tags and active projects**, so agents reuse tags (owner). A project counts as active unless it is marked done.
  - **Agents can create projects (owner).** A tag input may say `kind: project`. It applies only when the tag is new; an existing tag keeps its kind, and the returned link shows the kind the tag actually has. Changing an existing tag's kind will come in two places (owner): phase 4's web tag management and an agent tool (#23).
  - When one save names a tag twice, the kind comes from the mention with the strongest source, or the first mention on a tie. This keeps a guessed project from being recorded as stated.
  - **`save_link` has no `note` field (owner).** The agent turns what the owner said into a `stated` why, which changes spec §5.
  - **Spec §11 checks:**
    - MCP SDK v2 servers do have an `instructions` field (`@modelcontextprotocol/server` 2.3.1).
    - OpenAI's MCP guide says ChatGPT respects `readOnlyHint` and treats tools without it as writes needing confirmation. Behaviour in the app is still for the phase 1b spike.
  - **MCP decisions rest on the current documentation (owner).** Each one is cited in `docs/specs/2026-10-11-mcp-door-sources.md`:
    - The server speaks the 2026-07-28 revision, and also the 2025 handshake that Codex still sends.
    - It validates Origin.
    - Every tool sets all four hints.
    - Claude Code and Codex use a per-agent bearer key. That deliberately departs from the spec's SHOULD for OAuth until phase 3.
- **2026-10-11:** Keyword search (#4). An FTS5 table (`link_search`) over title, summary, why and tag names, kept current by database triggers inside the store's own transactions. Search words are OR-ed and ranked with bm25, so a half-wrong memory still finds links. Archived links are included in results. Stated limits: all owners share one index, so another owner's links can change the order of yours but never which links you get back (revisit before multi-user hosting, phase 3); results are current links, so a link edited after ranking can come back with text that no longer matches; with stemming, prefixes match stems (`runn` finds nothing, `run` and `running` do), which phase 4's search-as-you-type must revisit.
- **2026-10-11:** SQLite store (#3). Plain SQL on better-sqlite3, with migrations tracked by `PRAGMA user_version`. Link and tag ids are integers, shown as decimal strings; dates are stored as epoch milliseconds. The tag catalog is per owner, and link–tag rows carry composite foreign keys so they cannot cross owners. Owners are created by `SqliteStore.ensureUser`, outside `LinkStore`. Profile-notes and focus-log tables wait for phase 2 (owner). PR B landed at ~600 lines, over the ceiling, so that its tests stay with the code (owner).
- **2026-10-10:** Duplicate links (owner, #2). Two URLs are the same link after ignoring scheme/host case, default port, tracking parameters, trailing slashes and `#` anchors; `#/` and `#!` app routes, query order, http vs https and `www.` still count. URLs with credentials are refused. Saving an existing link returns it unchanged, except that a why is filled in if the link has none. Details: #2.
- **2026-10-10:** Tags (#2). Tag names match ignoring case and extra spaces; a tag keeps the casing it was first saved with. When one save names a tag twice, the stronger source wins (stated, then asked, then inferred). Blank tag names are refused.
- **2026-10-10:** Ruleset "main: require green CI" requires the `check` status on `main`, with no bypass. This supersedes the next entry's note that a direct push to `main` skipping the hook goes unchecked.
- **2026-10-10:** Phase 0 tooling is npm, TypeScript strict, Biome, Vitest, and a native git hook via `core.hooksPath`. CI runs `npm run check` on pull requests only, so a direct push to `main` that skips the hook goes unchecked; work goes through pull requests.
- **2026-10-10:** The ~400-line pull request ceiling is waived for the phase 0 pull request (owner).
- **2026-10-10:** The phase 1b ChatGPT spike may briefly expose a **throwaway toy server** (no real data, one dummy write tool) through Funnel, then turn Funnel off. This is the only exception to "no Funnel before auth", which still applies in full to the real app (spec §8, §10).
- **2026-10-10:** The owner is the admin of the ChatGPT Business workspace, so developer mode can be enabled.
- **2026-10-10:** Repo is private until phase 4 is done, then public.
- **2026-10-10:** Spec approved by the owner; phase 0 started.
