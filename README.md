# Aye-AI-AI Links

**Your links, remembered by your AI.**

You save a link, forget where, forget when, and forget why. Aye-AI-AI Links is a personal link library that your AI assistants run for you. It works with Claude Code, Codex, Claude Desktop, or any AI that speaks [MCP](https://modelcontextprotocol.io).

> **Status: in use, still growing.** The server runs on a home Mac, and AIs on the same [tailnet](https://tailscale.com/kb/1136/tailnet) can save and find links. Some features are still to come; [ROADMAP.md](ROADMAP.md) has the phases.

## What it does

You talk to your AI; it uses the library for you.

- **Save by talking.** Give your AI a link and a few words. It saves the link with a summary, tags, and a note on *why* you saved it. If you didn't say why, it asks once or makes a guess, and guesses are labelled as guesses.
- **Find by describing.** Ask for "that article about batteries from spring". Your AI turns that into a search that matches links by meaning as well as by their words, with optional filters for tag, project and date saved. Common words like "the" or "that" are ignored in the keyword match unless the query has nothing else. The first start after upgrading to this version embeds every saved link in the background; until a link is embedded, it is found by its words only.
- **Tidy up.** Ask your AI to change a link's summary, why or tags, or archive it.
- **Topics and projects.** A tag is a topic by default. Say "make home batteries a project" and it becomes a project you can filter by. Every tag records who decided its kind: you, or your AI's guess. A project your AI only guessed is presented as a guess until you confirm it. Tags from before this was recorded count as guesses too.
- **It learns about you.** Your AI keeps short notes about you and what you're working on, and reads them before guessing why you saved something. It changes or removes a note only when you ask.
- **Page snapshots.** The server fetches each new link's page and keeps its text, so a search also matches what the page says. A save waits a few seconds for the page, so your AI usually sees the page's title and opening text straight away, and it can read more of the text later. The first start after upgrading to this version fetches every link already in the library, two pages at a time.
- **Digests.** Ask "anything I should look at?" and your AI gets up to five saved links worth another look, each with its reasons: it shares words with something you're working on, it has no why yet, it was saved over 30 days ago and no AI has recorded you opening it in that time, or it has never come up before. Your AI turns those into a short nudge, and can ask why you saved one, snooze it or archive it. A link that comes up in a digest stays out of digests for two weeks, so the next digest brings different links. Snoozed links stay out until the snooze ends, and archived links never come up.

Each AI has its own key or its own app connection, and every link records which AI saved it.

The tools your AI uses:

| Tool | What it does |
|---|---|
| `save_link` | Saves a link. Saving one that's already saved returns the existing link. |
| `update_link` | Changes a link's title, summary, why, tags, state or snooze date. |
| `update_tag` | Switches a tag between topic and project, or confirms its kind as yours. |
| `search_links` | Finds links, best match first. A blank search lists the newest. |
| `get_link` | Opens one link by its id, with its page's text (up to 20,000 characters). |
| `get_profile` | Reads the notes about you and your active projects. |
| `add_profile` | Adds a note about you, or what you're working on now. |
| `edit_profile` | Changes or removes notes, when you ask. |
| `get_digest` | Picks a few links worth another look, with the reasons, and marks them shown. |

### Still to come

- **A web page** for browsing, designed for ADHD brains: lots of space, one thing at a time, and colors that mean something. For now, signing in shows a plain list of your newest links, and a page of the apps you've connected, where you can disconnect one.
- **ChatGPT and the Claude phone and web apps** in daily use. They sign in through OAuth (step 7 below), but their servers can only reach the server once it is on the public internet, which waits for the owner-isolation tests and port 443.
- **A JSON API** for scripts and shortcuts.

## How it works

One small server you host yourself, which AIs reach over MCP.

The AI you're talking to does the thinking: summaries, tags, the why. The server stores, searches and fetches the pages you save, and needs **no AI API keys**. Data lives in one SQLite file on your machine. That file also keeps your searches and the link your AI opened next, to tune meaning search; they never leave your machine. Your web login, its sessions and your AI apps' connections live in a second SQLite file beside it.

## Run it on your Mac

The server runs as a per-user macOS LaunchAgent on `127.0.0.1`, and [Tailscale Serve](https://tailscale.com/kb/1312/serve) makes it reachable on your tailnet. Replace `<your-mac>.<tailnet>.ts.net` with your Mac's tailnet name.

1. Create `~/.aye-links/aye.env`:

   ```sh
   AYE_DB=/Users/<you>/.aye-links/data/links.db
   AYE_PORT=3002
   AYE_ALLOWED_HOSTS=<your-mac>.<tailnet>.ts.net
   AYE_AUTH_DB=/Users/<you>/.aye-links/data/auth.db
   AYE_AUTH_SECRET=<a random secret>
   AYE_BASE_URL=https://<your-mac>.<tailnet>.ts.net:8444
   ```

   `AYE_DB` is required and must be an absolute path. `AYE_PORT` defaults to 3002. `AYE_ALLOWED_HOSTS` is a comma-separated list of the host names the server answers to; `localhost` and `127.0.0.1` are always allowed.

   The other three are for the web login, and the server will not start without them:
   - `AYE_AUTH_DB` is the absolute path of the login database. It must be a different file from `AYE_DB`.
   - `AYE_AUTH_SECRET` signs the session cookies and must be at least 32 characters. Make one with `openssl rand -base64 32`.
   - `AYE_BASE_URL` is the address your browser uses, with `https://` and no path or trailing slash: the Tailscale Serve address from step 3.

   Don't set any `BETTER_AUTH_` variable. The login library reads them, so the server and the `owner` command refuse to run while one is set.

   Upgrading an install from before the web login? Add these three settings first, then deploy, then set your login (step 4). Without `AYE_AUTH_DB`, the deploy refuses before it stops anything. Without the secret or the base URL, the new release refuses to start and the deploy rolls back.

2. Deploy a commit from `main`:

   ```sh
   deploy/deploy.sh main
   ```

   This builds and tests the commit, then downloads and checks the meaning-search model (about 35 MB, into `~/.aye-links/models`; only missing files are fetched) before it stops the service. It then backs up both databases, switches to the new release and starts it. It prints `Deployed <sha>.` when it has succeeded. A failed build, test or model check leaves the running install alone, and a failure while switching rolls back to the previous release.

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

3. Serve it on the tailnet:

   ```sh
   tailscale serve --bg --https=8444 http://127.0.0.1:3002
   ```

4. Set your web login. The `owner` command changes the login only while the server is stopped, and refuses while it runs. Like the key commands, run it from `current` and not at the same time as a deploy. It reads the password from stdin, never from the command line:

   ```sh
   owner() { node --env-file="$HOME/.aye-links/aye.env" "$HOME/.aye-links/current/dist/cli/owner-main.js" "$@"; }
   launchctl bootout gui/$(id -u)/com.aye-links
   IFS= read -rs PASSWORD && printf '%s\n' "$PASSWORD" | owner set you@example.com; unset PASSWORD
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.aye-links.plist
   ```

   The password must be 8 to 128 characters. Then sign in at `https://<your-mac>.<tailnet>.ts.net:8444/login`. Run the same commands to change the email or password; that also signs out every session. Sign-up is closed: this is the only way to make a login, and it belongs to the owner named by `AYE_OWNER` (default `owner`), so you see the same library as your AIs. Sign-in allows 10 attempts per 15 minutes from everyone together, and a separate 10 for sign-ins from your tailnet, so strangers using up the first can't lock you out from your own devices.

5. Make a key for each AI. Run key commands from `current`, so they use the same build as the server, and not at the same time as a deploy.

   ```sh
   keys() { node --env-file="$HOME/.aye-links/aye.env" "$HOME/.aye-links/current/dist/cli/keys-main.js" "$@"; }
   keys create codex
   keys list
   ```

   `create` prints the key once, so store it straight away. To stop a key working, revoke it:

   ```sh
   keys revoke codex
   ```

   New keys belong to the owner named by `AYE_OWNER` and `AYE_OWNER_NAME`, which default to `owner` and `Owner`. Leave them unset for a library of your own.

6. Connect each AI with its own key.

   **Claude Code:**

   ```sh
   claude mcp add --transport http aye-links https://<your-mac>.<tailnet>.ts.net:8444/mcp --header "Authorization: Bearer <key>"
   ```

   **Codex**, in `~/.codex/config.toml`, with the key in the `AYE_LINKS_KEY` environment variable:

   ```toml
   [mcp_servers.aye-links]
   url = "https://<your-mac>.<tailnet>.ts.net:8444/mcp"
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
           "https://<your-mac>.<tailnet>.ts.net:8444/mcp",
           "--transport", "http-only",
           "--header-file", "/Users/<you>/.aye-links/claude-desktop.headers"
         ],
         "env": { "PATH": "/Users/<you>/.nvm/versions/node/<version>/bin:/usr/bin:/bin:/usr/sbin:/sbin" }
       }
     }
   }
   ```

7. **Not yet:** do not put the server on the public internet, or follow this step, until the owner-isolation tests (#78) and the lockout fix (#79) are done.

   Connect ChatGPT or the Claude apps through OAuth. Instead of a key, they sign you in on the server and ask you to approve them. Their servers call yours, so the server must be reachable from the internet on port 443, and `AYE_BASE_URL` must be that public address (for example `https://<your-public-host>`), with its host in `AYE_ALLOWED_HOSTS`.

   **Claude** (web, desktop and phone apps): add a custom connector with the URL `https://<your-public-host>/mcp`.

   **ChatGPT:** add a custom MCP server with the URL `https://<your-public-host>/mcp` and OAuth as its authentication.

   Each app opens the server's sign-in page, then asks you to allow it to read and save links in your library. Once you allow it, every link it saves records the app's own name (for example "Claude"). Claude and ChatGPT identify themselves with a client document they publish; the server reloads it every few minutes, and refuses the app while it is gone or has not loaded for 5 minutes. At most 5 new apps can wait for your approval at once.

   To disconnect an app, open **Connected apps** from the home page (`/connections`) and choose **Disconnect**. Its tokens, your approval and its unused sign-in codes are deleted, so it is refused from its next request; to use it again, connect it again and approve it.

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
