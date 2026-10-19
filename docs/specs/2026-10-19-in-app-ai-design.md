# Ask AI: an AI inside the app (#159)

Dated 2026-10-19. Design of record for #159, approved by the owner on 2026-10-19. Owner answers are recorded on #159. The approved mockup is `docs/design/ask-ai-panel-mockup.html`. Where this text and the mockup disagree about how something looks or reads, the mockup wins. A builder who finds a conflict raises it with the owner instead of choosing.

## Why

Today the library is run by AIs outside it: Claude, ChatGPT and Codex reach it through MCP. To save or find a link, the owner has to leave the app and go to one of them. The owner wants to talk to the library from inside the app: save a link through chat, search by describing, and later have the server write summaries (#160). The app must still work exactly as today when no AI is set up.

## Goals

- An **Ask AI** panel, reachable from every signed-in page when an AI is set up, that can save, find and update links through chat.
- The panel knows the page the owner is on, and can answer about it: "what's in here about tiles?" on a space page.
- One AI connection serves the whole app. It can be a local AI (Ollama or LM Studio on the home Mac), ChatGPT through the OpenAI API, or Claude through the Anthropic API.
- The rest of the app is unchanged, and keeps working, when no AI is set up or the AI is down.

## Non-goals

- A settings page for the AI. It's set up in the server's settings file for now; the page is #175.
- A different AI per job. One default serves everything (owner, 2026-10-19).
- Server-made summaries. They are #160, which builds on this design's connection.
- Keeping chat history after the panel is closed, or across devices.
- Deleting links through the AI. AIs archive; only the owner deletes (#126).

## Anti-goals

These would make it a failure even if it worked:
- The home page's "What are you trying to remember?" search stops being instant, free and always available.
- An AI's guess shows as if the owner said it.
- A page with the AI off looks different from today's.

## Owner decisions (2026-10-19, #159)

1. **Where it lives.** A side panel opened by **Ask AI** in the top menu. On desktop it is a column on the right, and the page narrows to make room. On a phone it is a full-screen sheet with a back button naming the page it came from. The home search stays as it is.
2. **Which AIs.** All three. Two connectors sit behind one interface:
   - OpenAI's Chat Completions format with a configurable base URL, which covers ChatGPT, Ollama and LM Studio;
   - Anthropic's own Messages API for Claude. Anthropic's docs say its OpenAI-compatible layer is not for production use.
3. **One default AI** for every job.
4. **Set up in the settings file**: `AYE_` settings in `aye.env`.
5. **Guesses are labelled by the same rule** as the connected AIs:
   - what the owner says in the chat is "stated";
   - what the AI works out is "inferred" and shown as a guess;
   - the link records the in-app AI as the one that saved it.
6. **No AI set up:** no Ask AI anywhere, and pages are byte-for-byte as today. **AI down:** the panel stays and says what happened, nothing is saved half-done, and it offers a search for the owner's words.
7. **Look**, from the reviewed mockup (the full list is under "The approved screens" below):
   - the owner's messages are quiet grey text on the right, not bubbles;
   - the AI's answers name links as the app's own picture cards;
   - Ask AI looks like the other menu links, underlined while open;
   - one rule, above the message box;
   - the panel header reads "Using Claude, on Kitchen remodel" (the AI's name, then the page);
   - when an answer names links on the page behind it, the other cards fade. Nothing is outlined, since a blue outline means keyboard focus.

8. **Which AI matters most** (owner, 2026-10-19):
   - Claude is the main use;
   - a low-cost OpenAI model through the API should also work;
   - a decent local model through Ollama is the hope, because people want one.

   The home Mac is an M1 Pro with 32 GB of memory, and Ollama is already running there. Checked on 2026-10-19, these installed models report tool support:
   - `qwen3.5:9b` and `qwen3.5:4b`;
   - `qwen3:8b`;
   - `llama3.1:8b`;
   - `granite4:3b`.

   The disk has 18 GB free. My call: the first PR tests the tool loop for real against Claude and against `qwen3.5:9b` on the home Mac. If the local model can't use the tools reliably, that is reported to the owner with what was tried (another model, or sending less), rather than blocking Claude.

## The approved screens, piece by piece

The look is checked against this list and `docs/design/ask-ai-panel-mockup.html` before each PR of the panel is opened. The coloured blocks in the mockup stand in for real page pictures.

1. **Home, desktop, with the panel open.**
   - The menu reads All links, Tags, Profile, Apps, then **Ask AI**. Ask AI has a speech-bubble icon, looks like the other menu links, and is underlined while the panel is open.
   - The page narrows. The home question, its field, **Find it** and the hint are unchanged.
   - The panel sits on the right on a white surface with a left border. Its header has **Ask AI**, the line "Using Claude, on Home", and on the right **Start over** (an underlined text button) and a close ✕.
   - The owner's message is quiet grey text, aligned right, with no bubble. The AI's reply is plain text, followed by the saved link as a picture card: picture on the left, title as a link, the why in quotes, then the tags. An inferred tag has a dashed outline and reads "(a guess)".
   - Under the card are **Edit** and **Undo** buttons.
   - At the bottom, above one rule, are the message box ("Ask, or paste a link to save") and **Send**. That rule is the only one in the panel.
2. **Space page, desktop, with the panel open.**
   - The header reads "Using Claude, on Kitchen remodel".
   - A small centred grey line, "Earlier, on Home: saved …", shows the conversation carried over.
   - The answer names the matching links as picture cards with a one-line note each. On the page behind, the cards that don't match are faded. Nothing is outlined.
3. **Phone.**
   - Ask AI fills the screen as a white sheet. The top row has a back button naming the page it came from ("‹ Kitchen remodel") and **Start over**. Below it are **Ask AI** and the "Using Claude, on …" line.
   - Answers use picture cards with a small square picture.
   - A follow-up action ("save the zellige one to my handy shelf") is answered with one line and an **Undo** button.
   - The message box and **Send** sit at the bottom.
4. **The AI isn't answering** (phone shown).
   - In place of a reply is an alert box. Its bold first line says what happened ("Claude didn't answer: the connection timed out."), then "Nothing was saved or changed. Try again, or search your links the usual way."
   - Two buttons follow: **Try again**, and **Search for "<the owner's words>"**.
5. **No AI set up.** Today's home page exactly, with no Ask AI in the menu.

## How it works (decided)

- **The panel reuses the MCP tools.** The in-app AI calls the app's own MCP server, in the same process, as the owner, with the same tools, descriptions and `guidance.ts` instructions the connected AIs get. So:
  - every rule still lives once in `core/`;
  - there's no second copy of tool descriptions to drift;
  - deleting stays impossible because no tool deletes.

  This is my call. The builder check confirmed it works with the installed packages:
  - `buildMcpServer(deps, caller, track)` already takes the caller, so passing `{ owner, savedBy: "In-app AI (<name>)" }` scopes every tool to the owner;
  - `InMemoryTransport.createLinkedPair()` from `@modelcontextprotocol/server` 2.3.1 carries `initialize`, `tools/list` and `tools/call`, and `initialize` returns the instructions;
  - no MCP client is installed. Either add `@modelcontextprotocol/client` at the same 2.3.1, or send the three requests by hand. That choice is the builder's;
  - pass the same `track` the MCP door uses, so shutdown waits for in-app tool calls too.
- **`savedBy`** for the in-app AI is "In-app AI (<AI name>)", such as "In-app AI (Claude)". My call.
- **The server now calls an AI model.** This reverses the AGENTS.md principle "The calling agent does the AI work. The server never calls an AI model API and needs no API keys." The same PR replaces it with: the server calls a model only through the one AI connection, and only when it is set up; everything else works without it. The PR also adds a dated ROADMAP decision entry.
- **The AI connection is not the page fetcher.** It must reach a local AI on loopback (Ollama on `127.0.0.1:11434`), which the safe fetcher refuses by design. It talks only to the one configured base URL.
- **Settings** (names are my call; `src/readme.test.ts` will require them in the README):
  - `AYE_AI_API`: `openai` or `anthropic`;
  - `AYE_AI_URL`: the base URL. It defaults per API, and is required for a local AI;
  - `AYE_AI_KEY`: optional for a local AI;
  - `AYE_AI_MODEL`: required;
  - `AYE_AI_NAME`: the name shown in the panel and in `savedBy`. It defaults to "Claude" for `anthropic` and to the model name otherwise.

  Without `AYE_AI_API`, the AI is off. A partial setup stops the server at start-up with a message naming the missing setting, the same way the other `AYE_` settings do.
- **Conversation state lives in the browser.**
  - The panel keeps the conversation in `sessionStorage`, so it follows the owner between pages and ends when the tab closes or on **Start over**.
  - Each turn posts the conversation, plus where the owner is (the page's path and the ids of the links it shows), to one signed-in route.
  - The server keeps nothing between turns.
  - The route joins `CHECKED_PAGES` and the isolation guard like any signed-in POST.
- **Limits.** Each turn makes at most a fixed number of model calls (tool steps) and has an overall time limit, so a looping or slow model can't hang the panel. The values are the builder's.
- **What "nothing is saved half-done" means.** Each tool call is whole: it saves completely or not at all. A turn can make several calls, and when it fails partway, the changes already made stay. The panel lists them, with their Undo or Edit, under the error. The time limit stops a turn only between steps, never inside a tool call. My call: all-or-nothing turns would need new reverse operations for every tool.
- **Where the owner is.** Each turn carries the page's path and title, and the ids and titles of the links the page shows (at most the page's own count, 24). The server adds them to the model's messages as context, not as a tool. Their contents then come from the existing tools, such as `get_link`. No MCP tool changes, so the connected AIs see nothing new. My call.
- **Every change is listed, card or not.** A change to a link shows its card. A change with no card shows one plain line with a link to the page where it can be fixed, for example "Made kitchen remodel a project (Tags)" or "Removed the note 'training for a 10K' (Profile)". Those changes have no Undo, the same as when a connected AI makes them today. The in-app AI keeps the full tool set, including `edit_profile` and `update_tag`. The instructions already say to change notes and tag kinds only when the owner asks. My call.
- **Undo.**
  - A save made in the chat offers **Undo**, which deletes the new link through #126's delete.
  - A Keep handy offers the shelf's existing Undo.
  - Other edits offer **Edit**, which opens the link's existing edit dialog.

## Risks the design accepts

- **Prompt injection through saved pages.** Tool results can include a page's text, and a page can contain instructions. The AI then acts only through the owner's own tools, only on the owner's library, only during a turn the owner started, and it cannot delete. Every change it makes is shown in the panel with its card. Accepted.
- **Cost.** With a cloud AI, every turn is a paid call. There is no background use in this design.

## Left to the builder

- Streaming the reply versus showing it when it's done. Start without streaming unless it's cheap.
- How the panel's script and markup are shared across pages (`page()` is the natural home).
- The step and time limits.
- How the narrowed page lays out at laptop widths.

## Suggested landing order

1. Settings, the two connectors, the AI interface, the chat route with its MCP tool loop, and the AGENTS.md and ROADMAP change. Tested with a fake model.
2. The panel: desktop column, phone sheet, error and no-AI states, Undo and Edit. Plus the README.
3. Page awareness: sending where the owner is, and fading the cards that aren't named.
