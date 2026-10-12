# Aye-AI-AI Links

**Your links, remembered by your AI.**

You save a link, forget where, forget when, and forget why. Aye-AI-AI Links is a personal link library that your AI assistants run for you. It works with ChatGPT, Claude, Codex, Claude Code, or any AI that speaks [MCP](https://modelcontextprotocol.io).

> **Status: early development.** Nothing runs yet. This README describes what's being built. Progress is tracked in [ROADMAP.md](ROADMAP.md).

## What it will do

- **Save by talking.** Give any AI a link and a few words. It files the link with tags and a note on *why* you saved it, using what it knows about you.
- **Find by describing.** "That article about batteries and the tax credit, from spring" is enough. Search understands meaning, not just words.
- **Use your links in chat.** Ask "any links I saved that help with this?" and your AI searches your library and uses what it finds.
- **Get nudged.** Digests bring back old links that match what you're working on now.
- **See it calmly.** A simple, visual web page designed for ADHD brains: lots of space, one thing at a time, and colors that mean something.

## How it works

One small server you host yourself, with three ways in:

- **An MCP connector** that your AIs use to save, search and update links.
- **A JSON API** for scripts and shortcuts.
- **A web page** for browsing.

The AI you're talking to does the thinking: summaries, tags, the why. The server stores, searches and fetches pages, and needs **no AI API keys**. Data lives in one SQLite file on your machine.

The planned setup is a home computer, reachable from your phone through [Tailscale Funnel](https://tailscale.com/kb/1223/funnel), with the option to move to any host. The Mac setup is below.

## Run it on your Mac

The server runs as a per-user macOS LaunchAgent on `127.0.0.1`, and Tailscale Serve makes it reachable on your tailnet. Replace `<your-mac>.<tailnet>.ts.net` with your Mac's tailnet name.

1. Create `~/.aye-links/aye.env`:

   ```sh
   AYE_DB=/Users/<you>/.aye-links/data/links.db
   AYE_PORT=3002
   AYE_ALLOWED_HOSTS=<your-mac>.<tailnet>.ts.net
   ```

2. Deploy a commit. This builds and tests it under `~/.aye-links/releases/<sha>`, then stops the service, backs up the database, switches `~/.aye-links/current` and starts the service. A failed build or test leaves the running install alone. If the old service is not confirmed stopped within 25 s, including when the deploy is interrupted during that wait, the deploy ends there without changing or starting anything, so the service may be left down. After that, until the new release is listening, any failure or interruption rolls back: the previous release starts again (before the switch, only if its plist is installed), or, if there is no previous release, `current` and the plist are removed and the service stays stopped. If the schema changed or there was no database before, the failed release's database, with any writes it accepted, is moved to `~/.aye-links/data/backups/failed-*.db` and not merged back, and the backup, if any, is restored; otherwise the database is left as it is, writes included. If a rollback step fails, the script stops the service (and says if it could not confirm that), moves the plist to `~/.aye-links/com.aye-links.plist.disabled` so the failed release does not start at login, and writes `~/.aye-links/recovery-pending`; deploys refuse to run until you delete it. Once the new release is listening, the script prints `Deployed <sha>.` and the deploy has succeeded; it then removes old releases and backups, and interrupting that leaves the new release running. Only the current and previous releases and the 10 newest backups are kept.

   ```sh
   deploy/deploy.sh main
   ```

3. Serve it on the tailnet:

   ```sh
   tailscale serve --bg --https=8444 http://127.0.0.1:3002
   ```

4. Make a key for each agent. It is printed once. Run key commands from `current`, so they use the same build as the server, and not at the same time as a deploy.

   ```sh
   node --env-file=$HOME/.aye-links/aye.env $HOME/.aye-links/current/dist/cli/keys-main.js create codex
   ```

5. Connect an agent.

   Claude Code:

   ```sh
   claude mcp add --transport http aye-links https://<your-mac>.<tailnet>.ts.net:8444/mcp --header "Authorization: Bearer <key>"
   ```

   Codex, in `~/.codex/config.toml` (with the key in the `AYE_LINKS_KEY` environment variable):

   ```toml
   [mcp_servers.aye-links]
   url = "https://<your-mac>.<tailnet>.ts.net:8444/mcp"
   bearer_token_env_var = "AYE_LINKS_KEY"
   ```

A LaunchAgent runs only while your account is logged in, so keep it logged in. Whether the Mac sleeps is your setting to choose.

## Development

Requires Node 22.

```sh
nvm use
npm install        # also enables the pre-push git hook
npm run check      # typecheck, lint, test
```

Contributors and AI agents: start with [AGENTS.md](AGENTS.md).

## License

[MIT](LICENSE)
