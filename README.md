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

The planned setup is a home computer, reachable from your phone through [Tailscale Funnel](https://tailscale.com/kb/1223/funnel), with the option to move to any host. Setup instructions will come with the first runnable phase.

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
