# Aye-AI-AI Links

**Your links, remembered by your AI.**

You save a link, forget where, forget when, and forget why. Aye-AI-AI Links is a personal link library that your AI assistants run for you. It works with Claude Code, Codex, Claude Desktop, or any AI that speaks [MCP](https://modelcontextprotocol.io).

> **Status: in use, still growing.** The server runs on a home Mac. AIs on the same [tailnet](https://tailscale.com/kb/1136/tailnet) connect with keys, and the Claude and ChatGPT apps connect over the internet through a [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/). Some features are still to come; [ROADMAP.md](ROADMAP.md) has the phases. Each deploy of the home server is a [release](https://github.com/Nostoi/aye-ai-ai-links/releases) named by its date, and its notes list the pull requests merged since the last one.

## What it does

You talk to your AI; it uses the library for you.

- **Save by talking.** Give your AI a link and a few words. It saves the link with a summary, tags, and a note on *why* you saved it. If you didn't say why, it asks once or makes a guess, and guesses are labelled as guesses.
- **Find by describing.** Ask for "that article about batteries from spring". Your AI turns that into a search that matches links by meaning as well as by their words, with optional filters for tag, project and date saved. Common words like "the" or "that" are ignored in the keyword match unless the query has nothing else. The first start after upgrading to this version embeds every saved link in the background; until a link is embedded, it is found by its words only.
- **Go through everything.** Ask your AI how many links you have, or to go through all of them: newest first, oldest first, or the ones most recently opened (an opening counts when your AI records it or you open a link from the web page; opening it from a browser bookmark doesn't count). It pages through the whole library, past the 50 links a search returns, and can count only a tag, a project, archived links or a date range.
- **Tidy up.** Ask your AI to change a link's summary, why or tags, or archive it.
- **Topics and projects.** A tag is a topic by default. Say "make home batteries a project" and it becomes a project you can filter by. Every tag records who decided its kind: you, or your AI's guess. A project your AI only guessed is presented as a guess until you confirm it, and so is a project from before this was recorded. A topic is never shown as a guess, since every tag starts as one.
- **The top bar.** Every signed-in page has **All links** and **Spaces and tags**, then **Ask AI** when it is set up, then the account menu: a circle at the top right that holds **Profile**, **Apps and keys** and **Sign out**. On a phone the bar is the logo, **Ask AI** and a **Menu** button that holds all of these. The menu closes on Escape, on a click outside it, and when focus leaves the bar.
- **Tags page.** Signed in, open **Spaces and tags** in the top bar to see every tag. **Pin to home** makes a tag one of your spaces, and it gets a color no other tag has while one is free (past six colored tags, two spaces may share one). **Edit** lets you confirm or switch its kind, pick one of six colors, and mark a project **Done** or reopen it; a done project stops being suggested to your AI for filing. Unpinning and marking done show an **Undo** bar. Each tag's name opens its space.
- **Your spaces.** The home page shows your pinned tags as picture tiles, each in its color with up to three of its links' page images. A tile opens that space: its links, newest first, with pictures, 24 at a time (**Show older links** loads more). A link there with no why asks **Tell me why**, as on the home page. Links you've archived are not in the space; **Links you're done with** at the bottom lists them, faded. Every tag has a space page, pinned or not. A search result with a pinned tag names that space, in its color, and a "Worth a look today" card takes that color too.
- **All links.** Signed in, **All links** (first in the top bar) lists every link, tagged or not, grouped by month, 24 at a time with **Show older links**. Choose **Newest first**, **Oldest first** or **Recently opened**, which lists only the links whose opening was recorded (when you open it from the web page, or by your AI; not from a browser bookmark). Each card shows its picture, its space in color and its site; the page shows no counts. **Links you're done with** lists your archived links, faded, including those with no tag.
- **Your own title and picture.** On search results, All links, space pages and the pages of links you're done with, each card's **⋯** menu has **Edit title and picture…**. With Ask AI set up, the same dialog also opens from the Ask AI panel on every page with the menu (see Ask AI below). Rename the link, or press **Use it** to go back to the page's own title. Give it a picture by choosing a file, pasting a screenshot or dropping one on the dialog (PNG, JPEG, GIF or WebP), or go back to the page's picture. Big pictures are shrunk in your browser before they're sent. Your picture shows everywhere the link does, a later fetch of the page never replaces it, and an **Undo** bar puts the edit back unless the link changed since.
- **Deleting a link.** **Delete link** in a card's **⋯** menu, or at the bottom of its **Edit** dialog, removes the link at once from every page, search and AI. The **Undo** bar that appears brings it back unchanged. After a minute it can't be brought back, and within about two minutes of the delete the link and its why, tags, pictures, page text, Keep handy entry and saved copy are deleted for good (a link with a saved copy waits while saved copies are paused). Saving the same address again inside that minute makes a new link, and the old one can no longer be brought back. AIs can't delete links; they archive them.
- **Save from your browser.** Signed in, open **Apps and keys** from the account menu: **Save from your browser** has a **Save to Aye-AI-AI Links** button to drag to your bookmarks bar, and code to copy into a phone bookmark, with steps for iPhone, iPad and Android. On any page, tap the bookmark and a Save page opens in a new tab with the page's address and title filled in (a title is cut to 200 characters). Add why you're saving it if you like, and tap **Save**. Nothing is saved until you do. A page you saved before says "Already saved" with the date and a link to it, and an archived one offers **Bring it back**. Your why replaces an AI's guess, but never a reason already given; the page says so when yours isn't kept. If you're signed out, you sign in and come straight back. The bookmark never reads text you've selected. A page whose address is too long to send says so. The Save page is also at `/save`, as a plain form for adding a link by hand.
- **Download your data.** Signed in, open **Apps and keys** from the account menu: **Your data** has **Prepare export**. It shows "Preparing your export…" on the page, with no reload, and then a **Download** link with the file's size and when it was prepared (UTC). The zip, `aye-links-<date>.zip`, holds `links.json` (every link with its why, tags, their sources and dates, its Keep handy and link-check state, and your tags, profile notes and focus log), your pictures and the pages' pictures, your saved copies as Markdown files with front matter, and a `bookmarks.html` any browser can import. The file is kept for 24 hours and then it is gone; **Prepare again** makes a fresh one, which replaces the old one when it is ready. The files wait in an `exports` folder beside the database, which the server empties at each start. **Links only (.json)** downloads `aye-links-<date>.json` at once: the same `links.json`, without pictures or saved copies. Together they are the only export of the library: the database backups stay on the server's Mac and leave out saved copies, unless the copy folder is in a synced folder.
- **Ask AI.** If the server has its own AI set up (the `AYE_AI_` settings below), every page with the top bar has an outlined **Ask AI** button. It opens a panel beside the page, or a full-screen sheet on a phone, where you chat with that AI.
  - **What it can do.** Paste a link to save it, ask about your links, or ask it to change one. It uses the same tools as your other AIs, as you, and it can't delete links.
  - **Its answers.** Each answer is a sentence or two in plain text, with up to five of the links it means as picture cards; any more are named in the text. Its guesses are marked "(a guess)". Under the answer is a list of every change it made.
    - A new save, an edit to a link's title, summary, why or tags, and a Keep handy change each have **Undo**.
    - A saved or changed link's card also has **Edit**, which opens the same title-and-picture dialog as a card's **⋯** menu, on any page; it isn't offered after a save is undone. Opened from the panel, the dialog has no **Delete link**.
    - Undo of an edit works only while the link still holds what the AI wrote.
  - **It knows the page you are on.** Say "these" or "here" and it means the links the page shows. When an answer names links on that page, the page's other cards dim on a wide screen until your next message, **Start over** or closing the panel.
  - **When the AI doesn't answer.** The panel says why, lists anything already changed, and offers a search for your words.
  - **Where the conversation lives.** It follows you from page to page in the same browser tab; messages from other pages sit behind an "Earlier, on …" line that you press to show them and press again to hide them. It ends when you close the tab, sign out, or press **Start over**, and the server keeps none of it.
  - **No AI set up.** The top bar has no Ask AI, and every page is as before.
- **It learns about you.** Your AI keeps short notes about you and what you're working on, and reads them before guessing why you saved something. It changes or removes a note only when you ask, and you can see and fix the notes yourself on the Profile page.
- **Page snapshots.** The server fetches each new link's page and keeps its text, so a search also matches what the page says. A save waits a few seconds for the page, so your AI usually sees the page's title and opening text straight away, and it can read more of the text later. The first start after upgrading to this version fetches every link already in the library, two pages at a time.
- **Page images.** When a page names a preview image, the server fetches it in the background and keeps its own copy (PNG, JPEG, GIF or WebP, up to 2 MiB), so the web page shows it without asking any other site. When a page names no preview image it can use, the server fetches the site's icon instead, if the page declares one as PNG, JPEG, GIF or WebP. The icon must be at least 64 pixels on its shorter side, and the card shows it whole on a light plate. If the best icon can't be used, the next one is tried. A preview image the page names but that fails to load never falls back to the icon. Links saved before this version get the same check once, in the background, at most one page every 15 seconds: the server reads each page again only for its icon, and leaves its title, text and preview as they were. A link marked as gone waits until it works again. A picture you set yourself shows instead (see "Your own title and picture"). The first start after upgrading to this version fetches the images of links already saved. Your browser keeps a copy of each image it shows, and signing out asks your browser to clear it. A card whose link has no picture shows the title's initials (or the site's, when there is no title) on its space's colour.
- **Saved copies.** The server keeps a reading copy of each link whose page has an article: the article as Markdown, with its pictures as files beside it, in a folder on the server's Mac (see `AYE_SAVED_COPY_DIR` below). A copy is made once and never refreshed, so it stays as it was if the page changes or goes away. Links saved before this version get theirs in the background, if their page was fetched and doesn't seem gone. A page with no article gets no copy, and neither does a link you keep handy. A page or picture that fails 5 times is given up on, but a failure while the server's network is down doesn't count. While the folder is full, links without a copy, new or old, are skipped and tried again once there is room, pictures not yet fetched are left out, and no copy is ever deleted to make room. Read a copy from **Read saved copy** in its card's **⋯** menu on search results, All links, space pages and the pages of links you're done with, or from **Read the saved copy** on a card whose page seems gone. The copy page shows the article and its pictures, the date the copy was made and a link to the page itself, and loads nothing from other sites. If the copy's files are gone, after restoring a database backup for example, the page says so. Remove a copy with **Remove saved copy** in the same menu: the **Undo** bar that appears brings it back; a minute later its files are deleted and the link never gets a new copy. A line at the foot of All links says how much room saved copies use once they pass 80% of the limit, and when they are almost full or paused.
- **Digests.** Ask "anything I should look at?" and your AI gets up to five saved links worth another look, each with its reasons: it shares words with something you're working on, it has no why yet, it was saved over 30 days ago and no opening of it has been recorded in that time (an AI records one when you open a link it gave you, and so does the web page when you open a link from it, but not a browser bookmark), or it has never come up before. Your AI turns those into a short nudge, and can ask why you saved one, snooze it or archive it. A link that comes up in a digest stays out of digests for two weeks, so the next digest brings different links. Snoozed links stay out until the snooze ends, and archived links never come up. One of the five can instead be a tool you keep handy that has gone unopened for its wait: your AI asks "Still using it?" and says how many days it has been since an opening was recorded (or that none was), never that you haven't used it.
- **Keep handy.** Tell your AI you use a link regularly, such as a school's attendance site or a lunch-order form, and it keeps it handy: a tool, not reading, so it leaves the digest's nudges. If a page only looks like a tool, your AI may ask once whether you'll use it regularly; if it only guesses, the link is a suggestion until you say yes or no. A kept tool is asked about alone ("Still using it?") once 30 days pass, counted from the latest of its last recorded opening, its last "Still using it?" answer and the day you kept it; each yes with no opening since doubles the wait, up to 120 days, and any recorded opening sets it back to 30. Say it's not handy anymore and no AI suggests it again. A kept tool whose page is gone (see "How it works") is not asked "Still using it?".
- **Worth a look today.** Signed in, the web home page shows up to three links from the same queue as the digests, leaving out the tools the Handy shelf suggests (up to two): one large card with the reason in plain words, and two small ones. A link matching something you said you're working on takes the large card; the other picks are shuffled afresh each day, putting one card away leaves the others where they are, and looking at the page marks nothing as shown. **Open it** (or the title) opens the link in a new tab and keeps it off home for two weeks. **Not now** hides it for two weeks, **I'm done with it** archives it, and **Keep handy** moves it to your Handy shelf; each shows an **Undo** bar for a few seconds. A link with no why is outlined in amber and asks **Tell me why**: your answer is saved as yours and replaces an AI's guess, but never a reason you already gave. A link whose page seems gone is asked about in one small amber card at a time, with **I'm done with it** and **It still works**.
- **Handy shelf.** Links you use regularly, like a school's attendance site or a lunch-order form, go on a Handy shelf just below the search on the home page. They're one click away and are no longer nudged as reading.
  - The shelf shows up to eight. Any tool asking **Still using?** or **Seems gone** comes first, then the most recently opened. **Show all**, beside the shelf's heading, shows the rest, and on a phone the row scrolls sideways.
  - Each tool is a square postcard showing the title, with the site name under it. The link's saved picture fills the card, with a light fade behind the title. A link with no picture shows its space's color and the title's initials instead. A transparent picture, such as a logo, sits on white. The whole card opens the link.
  - Opening one from the shelf counts as an opening but doesn't mark it as shown.
  - When a tool goes unopened, from the web page or by your AI, for a wait counted from the latest of its last recorded opening, its last answer and the day you kept it, its tile asks **Still using?**. The wait starts at 30 days. When the tool comes up unopened and you say you're still using it, the wait doubles, up to 120 days, and any recorded opening sets it back to 30. **Yes** keeps the tool, and **Done** archives it, with an **Undo** bar. A tool whose page seems gone asks **Seems gone** instead: **It works** clears the mark and **Done** archives it, each with an **Undo** bar.
  - **Add**, beside the shelf's heading (or under it when the shelf is empty), opens a search that asks you to find the link to keep. It lists only active links, each with **Keep handy**. Active links in search results, All links and space pages have the same button, which reads **Handy · Not handy anymore** once a link is kept.
  - Up to two tools an AI only guessed at show faded at the end of the shelf, asking **Keep handy?** with **Yes** and **No**. A page that seems gone isn't suggested.
  - Each tile's **⋯** menu, in its top-right corner, has **Not handy anymore**, with an **Undo** bar.

Each AI has its own key or its own app connection, and every link records which AI saved it.

The tools your AI uses:

| Tool | What it does |
|---|---|
| `save_link` | Saves a link (a title is at most 200 characters). Saving one that's already saved returns the existing link. A new link can also be kept handy, or suggested. |
| `update_link` | Changes a link's title (at most 200 characters), summary, why, tags, state or snooze date, or whether it is kept handy. |
| `update_tag` | Switches a tag between topic and project, or confirms its kind as yours. |
| `search_links` | Finds links, best match first. A blank search lists the newest. |
| `list_links` | Lists every link, newest first, oldest first or most recently opened, a page at a time, with a total. |
| `get_link` | Opens one link by its id, with its page's text (up to 20,000 characters) and whether a saved copy of its page exists. |
| `get_profile` | Reads the notes about you and your active projects. |
| `add_profile` | Adds a note about you, or what you're working on now. |
| `edit_profile` | Changes or removes notes, when you ask. |
| `get_digest` | Picks a few links worth another look, with the reasons, plus at most one kept tool to ask "Still using it?" about, and marks them shown. |

### Still to come

- **A web page** for browsing, designed for ADHD brains: lots of space, one thing at a time, and colors that mean something. For now, signing in shows the home page (the search question, your Handy shelf, "Worth a look today" and your spaces), a search page (describe a link however you remember it and see the best matches, each with its page's image and its why), a page for each of your spaces, All links, the Tags page, a Profile page, a Save page, and an Apps and keys page, where you can disconnect an app, make or turn off your AIs' keys, and download your data. The Profile page shows the notes your AIs keep about you and what you've been working on lately, with each AI's guesses marked as guesses. You can add a note, edit one, confirm a guess with **That's right**, or remove one. A removed note is gone for your AIs at once, and for a few seconds an **Undo** bar can bring it back. If an AI changed a note after the page loaded, your change is refused and the page asks you to reload.
- **Saving from a phone's share sheet,** through a Shortcut that opens the Save page (`/save?url=…&title=…`).
- **A JSON API** for scripts.

## How it works

One small server you host yourself, which AIs reach over MCP.

The AI you're talking to does the thinking: summaries, tags, the why. The server stores, searches and fetches the pages you save and their images, and needs **no AI API keys** unless you set up its own AI with the `AYE_AI_` settings below. Data lives in one SQLite file on your machine, except saved copies of articles, which are files in their own folder. That file also keeps your searches and the link your AI opened next, to tune meaning search; they never leave your machine. The server also checks that saved pages still exist: weekly for active links and monthly for archived ones, one request at a time. A page counts as gone once two checks at least a week apart find it missing (a 404 or 410, or its site's name no longer exists while the server can still look up other names); a login wall, a server error or a timeout never counts. A gone page drops out of the digest and Worth a look's reading picks. Its cards say "This page seems gone", with **It still works** and **I'm done with it**, each with Undo, and every link your AI gets back says whether its page seems gone. A login-walled page is never marked. Your web login, its sessions and your AI apps' connections live in a second SQLite file beside it.

## Run it on your Mac

The server runs as a per-user macOS LaunchAgent on `127.0.0.1`. [Tailscale Serve](https://tailscale.com/kb/1312/serve) makes it reachable on your tailnet at `https://<your-mac>.<tailnet>.ts.net`, and a Cloudflare Tunnel makes it reachable on the internet at an address on your own domain, `https://links.<your-domain>`, for the web login and the Claude and ChatGPT apps (step 3). Replace both with your own names.

1. Create `~/.aye-links/aye.env`:

   ```sh
   AYE_DB=/Users/<you>/.aye-links/data/links.db
   AYE_PORT=3002
   AYE_ALLOWED_HOSTS=<your-mac>.<tailnet>.ts.net,links.<your-domain>
   AYE_AUTH_DB=/Users/<you>/.aye-links/data/auth.db
   AYE_AUTH_SECRET=<a random secret>
   AYE_BASE_URL=https://links.<your-domain>
   # AYE_SAVED_COPY_DIR=/Users/<you>/.aye-links/saved-copies
   # AYE_SAVED_COPY_LIMIT_GB=1
   # AYE_AI_API=anthropic
   # AYE_AI_URL=https://api.anthropic.com
   # AYE_AI_KEY=<your API key>
   # AYE_AI_MODEL=<a model name>
   # AYE_AI_NAME=Claude
   ```

   `AYE_DB` is required and must be an absolute path. `AYE_PORT` defaults to 3002. `AYE_ALLOWED_HOSTS` is a comma-separated list of the host names the server answers to; `localhost` and `127.0.0.1` are always allowed.

   `AYE_SAVED_COPY_DIR` is where the server keeps a saved copy of each link's article (Markdown, with its pictures fetched later). It defaults to `~/.aye-links/saved-copies`. It must be an absolute path outside the release folders. You can put it inside iCloud Drive or Dropbox, and the sync service then stores the copies too. It is not in the database backups. Links saved before this version get their copies in the background, one page every 15 seconds or so, and a copy's pictures are fetched in the background after the copy is made.
   - If the log says saved copies are paused, copies stop meanwhile and the app keeps working. All links also says so. When the log advises granting the Node binary access to the folder, do that in System Settings → Privacy & Security, then restart the service.
   - If the log says the folder belongs to another library (for example after a deploy rolled the database back), move the folder aside and restart. A new, empty one is made. A folder you delete by hand is made again within a minute or so, and the copies that were in it are missing.
   - Use one server per folder. A copied database pointed at the same folder (a second Mac sharing a synced folder) is not supported.

   `AYE_SAVED_COPY_LIMIT_GB` caps the folder's size in GiB (default 1). When it is full, new links get no copy and old copies are never deleted. Removing a copy frees its space soon after its Undo minute ends. `0` stops new copies; existing ones stay, and can still be read and removed.

   The other three are for the web login, and the server will not start without them:
   - `AYE_AUTH_DB` is the absolute path of the login database. It must be a different file from `AYE_DB`.
   - `AYE_AUTH_SECRET` signs the session cookies and must be at least 32 characters. Make one with `openssl rand -base64 32`.
   - `AYE_BASE_URL` is the address your browser uses, with `https://` and no path or trailing slash: the internet address from step 3. The web login and app connections work only at this address.

   Don't set any `BETTER_AUTH_` variable. The login library reads them, so the server and the `owner` command refuse to run while one is set.

   Upgrading an install from before the web login? Add these three settings first, then deploy, then set your login (step 4). Without `AYE_AUTH_DB`, the deploy refuses before it stops anything. Without the secret or the base URL, the new release refuses to start and the deploy rolls back.

   The five `AYE_AI_` settings are optional and turn on **Ask AI**, the AI that works inside the app (see "Ask AI" above). `AYE_AI_API` is `openai` (any server that speaks OpenAI's chat format, including local ones) or `anthropic`; with it unset the AI is off. `AYE_AI_MODEL` is the model to use. `AYE_AI_URL` is the address to talk to; it defaults to OpenAI's or Anthropic's own. `AYE_AI_NAME` is what the app calls the AI: it defaults to `Claude` for `anthropic` and to the model name otherwise. `AYE_AI_KEY` is your API key. It is required for `anthropic` and for `openai` at its default address; only an `openai` server at an `AYE_AI_URL` of your own, such as one on your Mac, can go without. For example, a local AI served by Ollama needs only `AYE_AI_API=openai`, `AYE_AI_URL=http://127.0.0.1:11434/v1` and `AYE_AI_MODEL=qwen3.5:9b`. If `AYE_AI_API` is missing while another `AYE_AI_` setting is set, or a needed setting is missing or the address is not `http` or `https`, the server refuses to start and names the setting. A cloud AI bills you for every turn of a conversation. The server talks to this one address and no other AI service.

2. Deploy a commit from `main`:

   ```sh
   deploy/deploy.sh main
   ```

   This builds and tests the commit, then downloads and checks the meaning-search model (about 35 MB, into `~/.aye-links/models`; only missing files are fetched) before it stops the service. It then backs up both databases, switches to the new release and starts it. It prints `Deployed <sha>.` when it has succeeded, and only then exits 0. A failed build, test or model check leaves the running install alone, and a failure while switching rolls back to the previous release.

   <details>
   <summary>Exactly what happens when a deploy fails</summary>

   - The commit is built and tested under `~/.aye-links/releases/<sha>`. Then the script stops the service, backs up both databases (`links-<time>.db` and `auth-<time>.db`, with the same time), switches `~/.aye-links/current` and starts the service.
   - If the old service is not confirmed stopped within 25 s, the deploy ends there without changing or starting anything, so the service may be left down. An interruption during that wait rolls back as below.
   - After the stop is confirmed, until the new release is listening, any failure or interruption rolls back: the previous release starts again (before the switch, only if its plist is installed), or, if there is no previous release, `current` and the plist are removed and the service stays stopped.
   - If the schema changed or there was no database before, the failed release's database, with any writes it accepted, is moved to `~/.aye-links/data/backups/failed-links-*.db` and not merged back, and the backup, if any, is restored; otherwise the database is left as it is, writes included.
   - The login database follows the same rule, set aside as `failed-auth-*.db`. When its backup is restored, every session, every app connection (its tokens and your approval) and every unused sign-in code in it is deleted, so you sign in and connect your AI apps again; a restored backup would otherwise bring back sessions you signed out and apps you disconnected since. Agent keys live in the links database and are not affected.
   - If a rollback step fails, the script stops the service (and says if it could not confirm that), moves the plist to `~/.aye-links/com.aye-links.plist.disabled` so nothing starts at login, and writes `~/.aye-links/recovery-pending`; deploys refuse to run until you delete it.
   - Once the new release is listening, the deploy has succeeded; the script then removes old releases and backups, and interrupting that leaves the new release running. Only the current and previous releases and the 10 newest backups of each database are kept.

   </details>

   The server tells your AIs its version when they connect. It is `dev` unless you give the deploy one, such as `deploy/deploy.sh main v2026.10.14`; the deploy then prints `Deployed <sha> as v2026.10.14.` This project's own deploys are named and published from a machine where `gh` is signed in, never from the server:

   ```sh
   version="$(deploy/release.sh next <sha>)"   # vYYYY.MM.DD, .2, .3 for later deploys that day; a commit already released keeps its name
   ssh <server> "cd <checkout> && deploy/deploy.sh <sha> $version" &&
     deploy/release.sh publish "$version" <sha>  # && publishes only if the deploy exited 0
   ```

   `publish` tags the commit and makes its GitHub release, with notes generated from the merged pull requests. It refuses if the tag already names another commit, and running it again finishes a release it did not.

3. Serve it. On the tailnet, for your AIs' keys:

   ```sh
   tailscale serve --bg --https=443 http://127.0.0.1:3002
   ```

   Installs from before used port 8444. Keep that serve if your AIs' keys point at it.

   On the internet, for the web login and the Claude and ChatGPT apps, use a Cloudflare Tunnel on a domain whose DNS is on Cloudflare. In the Cloudflare dashboard (Zero Trust → Networks → Tunnels), create a tunnel and run its connector on this Mac with the command the dashboard shows. Then add a public hostname such as `links.<your-domain>` with the service `http://127.0.0.1:3002`. Step 1's `AYE_ALLOWED_HOSTS` and `AYE_BASE_URL` must name this host; the server refuses requests for a host it doesn't list.

   When tested, ChatGPT's servers could not reach the app through a [Tailscale Funnel](https://tailscale.com/kb/1223/funnel) address, but reached it through a Cloudflare Tunnel (#102).

4. Set your web login. The `owner` command changes the login only while the server is stopped, and refuses while it runs. Like the key commands, run it from `current` and not at the same time as a deploy. It reads the password from stdin, never from the command line:

   ```sh
   owner() { node --env-file="$HOME/.aye-links/aye.env" "$HOME/.aye-links/current/dist/cli/owner-main.js" "$@"; }
   launchctl bootout gui/$(id -u)/com.aye-links
   IFS= read -rs PASSWORD && printf '%s\n' "$PASSWORD" | owner set you@example.com; unset PASSWORD
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.aye-links.plist
   ```

   The password must be 8 to 128 characters. Then sign in at `https://links.<your-domain>/login`. Run the same commands to change the email or password; that also signs out every session. Sign-up is closed: this is the only way to make a login, and it belongs to the owner named by `AYE_OWNER` (default `owner`), so you see the same library as your AIs. Sign-in allows 10 attempts per 15 minutes from everyone together, so strangers can use them up and keep you out for the rest of the 15 minutes. Restarting the server resets the count.

5. Make a key for each AI. Signed in, open **Apps and keys** from the account menu (`/connections`), type which agent it is for, such as "Codex on laptop", and choose **Make a key**. The key is shown once, so copy it straight away. **Turn off** stops a key from its next request. For a few seconds after, an **Undo** bar can turn it back on, unless a new key with the same name was made since. A name is up to 60 characters, and "web" is taken: it marks links saved on the web page.

   The same works from a shell. Run key commands from `current`, so they use the same build as the server, and not at the same time as a deploy.

   ```sh
   keys() { node --env-file="$HOME/.aye-links/aye.env" "$HOME/.aye-links/current/dist/cli/keys-main.js" "$@"; }
   keys create codex
   keys list
   ```

   `create` prints the key once, so store it straight away. To turn a key off:

   ```sh
   keys revoke codex
   ```

   Keys made in a shell belong to the owner named by `AYE_OWNER` and `AYE_OWNER_NAME`, which default to `owner` and `Owner`; keys made on the page belong to the web login, which is the same owner. Leave both settings unset for a library of your own.

6. Connect each AI with its own key.

   **Claude Code:**

   ```sh
   claude mcp add --transport http aye-links https://<your-mac>.<tailnet>.ts.net/mcp --header "Authorization: Bearer <key>"
   ```

   **Codex**, in `~/.codex/config.toml`, with the key in the `AYE_LINKS_KEY` environment variable:

   ```toml
   [mcp_servers.aye-links]
   url = "https://<your-mac>.<tailnet>.ts.net/mcp"
   bearer_token_env_var = "AYE_LINKS_KEY"
   ```

   **Claude Desktop** connects through [`mcp-remote`](https://www.npmjs.com/package/mcp-remote), which reads the key from a file. Put the line `Authorization: Bearer <key>` in `~/.aye-links/claude-desktop.headers` and run `chmod 600` on it. Add this to `~/Library/Application Support/Claude/claude_desktop_config.json`, with full paths to Node 22's `npx` and `bin` folder, then restart Claude Desktop:

   ```json
   {
     "mcpServers": {
       "aye-links": {
         "command": "/Users/<you>/.nvm/versions/node/<version>/bin/npx",
         "args": [
           "-y", "mcp-remote@0.14.3",
           "https://<your-mac>.<tailnet>.ts.net/mcp",
           "--transport", "http-only",
           "--header-file", "/Users/<you>/.aye-links/claude-desktop.headers"
         ],
         "env": { "PATH": "/Users/<you>/.nvm/versions/node/<version>/bin:/usr/bin:/bin:/usr/sbin:/sbin" }
       }
     }
   }
   ```

7. Connect ChatGPT or the Claude apps through OAuth. Instead of a key, they sign you in on the server and ask you to approve them. Their servers call yours, so they use the internet address from step 3.

   **Claude** (web, desktop and phone apps): in Settings → Connectors, add a custom connector with the URL `https://links.<your-domain>/mcp`. Keep "Sign in now" and "Use Claude's published identity", and add no headers.

   **ChatGPT:** add a custom MCP server with the URL `https://links.<your-domain>/mcp` and OAuth as its authentication. When tested, ChatGPT did not ask for confirmation before saving or editing.

   Each app opens the server's sign-in page, then asks you to allow it to read and save links in your library. Once you allow it, every link it saves records the app's own name (for example "Claude"). Every app you allow gets a refresh token, even when it doesn't ask for one, so it stays connected while you use it instead of asking you to sign in again each hour. Claude and ChatGPT identify themselves with a client document they publish; the server reloads it every few minutes, and refuses the app while it is gone or has not loaded for 5 minutes. At most 5 new apps can wait for your approval at once.

   To disconnect an app, open **Apps and keys** from the account menu at the top of any page (`/connections`) and choose **Disconnect**. Its tokens, your approval and its unused sign-in codes are deleted, so it is refused from its next request; to use it again, connect it again and approve it.

A LaunchAgent runs only while your account is logged in, so keep it logged in. Whether the Mac sleeps is your setting to choose.

## Development

Requires Node 22.

```sh
nvm use
npm install
npm run check
```
Contributors and AI agents: start with [AGENTS.md](AGENTS.md). `src/readme.test.ts` fails when this README leaves out a tool the server offers or an `AYE_` setting the code reads.

## License

[MIT](LICENSE)
