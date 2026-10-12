# Aye-AI-AI Links

**Your links, remembered by your AI.**

You save a link, forget where, forget when, and forget why. Aye-AI-AI Links is a personal link library that your AI assistants run for you. It works with Claude Code, Codex, Claude Desktop, or any AI that speaks [MCP](https://modelcontextprotocol.io).

> **Status: in use, still growing.** The server runs on a home Mac, and AIs on the same [tailnet](https://tailscale.com/kb/1136/tailnet) can save and find links. Some features are still to come; [ROADMAP.md](ROADMAP.md) has the phases.

## What it does

You talk to your AI; it uses the library for you.

- **Save by talking.** Give your AI a link and a few words. It saves the link with a summary, tags, and a note on *why* you saved it. If you didn't say why, it asks once or makes a guess, and guesses are labelled as guesses.
- **Find by describing.** Ask for "that article about batteries from spring". Your AI turns that into a word search, with optional filters for tag, project and date saved.
- **Tidy up.** Ask your AI to change a link's summary, why or tags, or archive it.
- **Topics and projects.** A tag is a topic by default. Say "make home batteries a project" and it becomes a project you can filter by.
- **It learns about you.** Your AI keeps short notes about you and what you're working on, and reads them before guessing why you saved something. It changes or removes a note only when you ask.

Each AI has its own key, and every link records which AI saved it.

The tools your AI uses:

| Tool | What it does |
|---|---|
| `save_link` | Saves a link. Saving one that's already saved returns the existing link. |
| `update_link` | Changes a link's summary, why, tags, state or snooze date. |
| `update_tag` | Switches a tag between topic and project. |
| `search_links` | Finds links, best match first. A blank search lists the newest. |
| `get_link` | Opens one link by its id. |
| `get_profile` | Reads the notes about you and your active projects. |
| `add_profile` | Adds a note about you, or what you're working on now. |
| `edit_profile` | Changes or removes notes, when you ask. |

### Still to come

- **Page snapshots:** the server saves the text of each page, so a search can match what a page says.
- **Search by meaning**, not just by matching words.
- **Digests** that bring back old links that match what you're working on now.
- **A web page** for browsing, designed for ADHD brains: lots of space, one thing at a time, and colors that mean something.
- **ChatGPT and the Claude phone and web apps**, once login is built.
- **A JSON API** for scripts and shortcuts.

## How it works

One small server you host yourself, which AIs reach over MCP.

The AI you're talking to does the thinking: summaries, tags, the why. The server stores and searches, and needs **no AI API keys**. Data lives in one SQLite file on your machine.

## Run it on your Mac

The server runs as a per-user macOS LaunchAgent on `127.0.0.1`, and [Tailscale Serve](https://tailscale.com/kb/1312/serve) makes it reachable on your tailnet. Replace `<your-mac>.<tailnet>.ts.net` with your Mac's tailnet name.

1. Create `~/.aye-links/aye.env`:

   ```sh
   AYE_DB=/Users/<you>/.aye-links/data/links.db
   AYE_PORT=3002
   AYE_ALLOWED_HOSTS=<your-mac>.<tailnet>.ts.net
   ```

   `AYE_DB` is required and must be an absolute path. `AYE_PORT` defaults to 3002. `AYE_ALLOWED_HOSTS` is a comma-separated list of the host names the server answers to; `localhost` and `127.0.0.1` are always allowed.

2. Deploy a commit from `main`:

   ```sh
   deploy/deploy.sh main
   ```

   This builds and tests the commit, backs up the database, switches to the new release and starts it. It prints `Deployed <sha>.` when it has succeeded. A failed build or test leaves the running install alone, and a failure while switching rolls back to the previous release.

   <details>
   <summary>Exactly what happens when a deploy fails</summary>

   - The commit is built and tested under `~/.aye-links/releases/<sha>`. Then the script stops the service, backs up the database, switches `~/.aye-links/current` and starts the service.
   - If the old service is not confirmed stopped within 25 s, the deploy ends there without changing or starting anything, so the service may be left down. An interruption during that wait rolls back as below.
   - After the stop is confirmed, until the new release is listening, any failure or interruption rolls back: the previous release starts again (before the switch, only if its plist is installed), or, if there is no previous release, `current` and the plist are removed and the service stays stopped.
   - If the schema changed or there was no database before, the failed release's database, with any writes it accepted, is moved to `~/.aye-links/data/backups/failed-*.db` and not merged back, and the backup, if any, is restored; otherwise the database is left as it is, writes included.
   - If a rollback step fails, the script stops the service (and says if it could not confirm that), moves the plist to `~/.aye-links/com.aye-links.plist.disabled` so nothing starts at login, and writes `~/.aye-links/recovery-pending`; deploys refuse to run until you delete it.
   - Once the new release is listening, the deploy has succeeded; the script then removes old releases and backups, and interrupting that leaves the new release running. Only the current and previous releases and the 10 newest backups are kept.

   </details>

3. Serve it on the tailnet:

   ```sh
   tailscale serve --bg --https=8444 http://127.0.0.1:3002
   ```

4. Make a key for each AI. Run key commands from `current`, so they use the same build as the server, and not at the same time as a deploy.

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

5. Connect each AI with its own key.

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
