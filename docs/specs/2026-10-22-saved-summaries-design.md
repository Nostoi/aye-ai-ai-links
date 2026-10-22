# Saved summaries (#160)

Owner conversation, 2026-10-22. Builds on the in-app AI connection (`docs/specs/2026-10-19-in-app-ai-design.md`, #159).

## Why

The owner often looks at a saved link, on All links, a space, Worth a look or in an AI's answer, and can't remember what it was about. They want a quick way to know without opening it.

Two things stand in the way today:

- **Many links have no summary, and the rest don't match.** On 2026-10-22, 27 of the 45 live links had one. It is whatever the saving AI wrote: about 85 characters on average from ChatGPT, 200 from Claude Desktop and 365 from Claude Code. The other 18 have none. 10 of those were saved through ChatGPT and 3 from the web.
- **Where a summary exists, the web shows it only on search results** (`resultItem`, `src/web/pages.ts`). All links and space rows show the title, why and grey line.

## Goals

- The server writes a short summary for every link whose page it could read, in one style, through the one AI connection (`src/ai/`).
- It replaces the summaries saving AIs wrote, the 27 existing ones included. A summary the owner gave is never replaced.
- All links and space page rows show the summary where the owner wrote no why.

## Non-goals

- No summary edit field on the web. The owner changes a summary by asking an AI.
- No summary on Home, Worth a look, the saved copy page, Tidy up or the Ask AI panel's cards in this work. These may come later. The in-app AI still reads summaries through its tools.
- No scheduling between the pass and Ask AI on the shared model. The pass makes one call at a time with a gap, which leaves room for chat.
- The server does not re-summarise when a page changes. One summary per link, unless the owner clears it (below).
- No cost tracking or usage limits beyond pacing.

## Anti-goals

- A server summary replaces something the owner gave.
- Rows get busier: a row with a why grows a summary line.
- The app needs an AI to work. With no `AYE_AI_` settings, everything behaves as today, apart from the new label being stored.

## Owner decisions (2026-10-22)

1. **Rows show the summary only where there's no why** (option C of the canvas mockups, section 6, "What was that link about?"). It takes the why's place, in grey, one line on desktop and two on a phone. Rows with a why are unchanged.
2. **The server replaces every summary a saving AI wrote**, the existing ones included, so all match.
3. **A summary the owner asked for sticks.** It is labelled like a why. **"stated"** or **"asked"** means the owner gave it, and the server never replaces it. **"inferred"**, or no label, means an AI wrote it on its own, and the server replaces it.
4. **No "(a guess)" mark on summaries.** The 2026-10-12 decision-log entry already treats a summary as the AI's description of the page, not a guess about the owner. This was the controller's proposal; the owner did not object.

## How it works

### Who wrote a summary

Each link records who wrote its summary, alongside the text:

| Value | Meaning | Server replaces it? |
|---|---|---|
| owner (`stated` or `asked`) | the owner gave or asked for it | never |
| `inferred` | an AI wrote it on its own | yes |
| none (legacy, or no summary) | written before this change, or empty | yes |
| server | the server wrote it | no; already done |

So a summary written by the server is never redone. One written by an AI on its own is redone. The owner's own summary stays.

**Writes follow the same order: owner over server over an AI on its own.** The controller decided these after the builder check:

- **An `inferred` summary fills only a gap.** It is written when the link has no summary, or one that is `inferred` or unlabelled. It never replaces the server's summary or the owner's. The check is made in the same atomic write as the rest of the edit, not before it, so an owner edit landing in between is never lost (solution challenge, objection 1). The edit's other fields are still written. Otherwise an AI touching a link would undo the server's summary, and the pass would redo it, over and over. When the owner wants the server's summary corrected, they ask for it, and that write is `stated` or `asked`.
- **An owner summary (`stated` or `asked`) always writes**, over anything.
- **A repeat `save_link` of a saved URL ignores the summary**, as it does today. Only a missing why is filled. A change goes through `update_link`.
- **`summary: null` clears the text and the label together**, whatever source is sent. The link is then one the server summarises again, from the page text it already has. It does not fetch the page again.
- **Summaries saved before this change have no label, so they are replaced.** That includes any the owner once asked an AI for. Nothing records which ones those were, and the owner chose to replace all of them.

**The rows above are the contract; the column shape is the builder's call.** For example, `summary_source` could hold `stated|asked|inferred|server` with a `CHECK`, as `why_source` does (`src/store/migrations.ts`). Or `summary_source` could be kept as a `Source` and the server's authorship recorded separately. Keep the `Source` type's three values meaning what they mean for a why.

### Agents send the label

- `save_link` and `update_link` accept `summary` as plain text, as today, or as `{text, source}` like the why.
- Plain text means `inferred`.
- An agent sends `stated` or `asked` only when the owner gave the words or asked for the change. The guidance in `src/mcp/guidance.ts` says so, in the words it already uses for the why.
- `update_link` with `summary: null` clears the summary. The server then writes a new one. This is how the owner asks to have one redone.
- Link results over MCP carry the label, so an AI can tell the owner's summary from the server's. `linkOutput` is strict and has a frozen fixture, so both change.

### The summary pass

A background pass, built like the existing passes in `src/start-server.ts`: started after listening, quiesced and stopped on shutdown, and added to every list there that names the passes.

- **Runs only when an AI is set up.** It gets the `ChatModel` from `startServer` (`ai: config.ai && createChatModel(config.ai)`). `createDeps` has no AI, and this design doesn't add one there.
- **Picks links** that are not deleted and whose summary the server may replace (the table above). Active and archived links both count: search finds both.
- **Needs page text.** It summarises a link only when its snapshot is `ok` with text. A link whose page has no readable text keeps whatever summary it has, and is picked up if a later fetch brings text. A server summary is final, so it is never written from the title alone (controller's call: a title-only sentence would add little and could invent).
- **One model call per link**, with no tools. The system prompt asks for one plain sentence about what the page is, at most `SUMMARY_MAX` characters. The page text is passed as material to summarise, never as instructions.
- **Writes conditionally.** It writes only if the link's summary and label are still what it read before the call. So an owner's edit made during the call is never overwritten.
- **Checks the reply.** It trims the reply to one line. A reply that is empty or still over the cap after trimming counts as a failure. The text is stored as plain text and escaped wherever it is shown, as summaries are today.
- **Paces itself.** One call at a time, with a gap between calls.
- **Handles failures.**
  - Any failure backs off that link alone, and the pass moves on to the next one. `AiUnavailable` also covers request-specific errors, such as an HTTP 400 for one page, so it says nothing about the AI as a whole.
  - The whole pass pauses only after several failures in a row on different links.
  - There is no attempt cap. A link that keeps failing is retried at most about once a day.
  - A link's backoff ends when its summary changes. So the owner clearing a summary always gets a fresh try.
- **Stops promptly.** On stop it aborts the call in flight through the request's `AbortSignal` and writes nothing for that link.

Everything else follows from the existing triggers and indexers:
- Keyword search re-indexes the new summary through the `link_search` triggers.
- Meaning search re-embeds it, since the summary is in `linkDocument`'s hash.

### Undo

The in-app AI's Undo receipts cover the summary text (`src/core/covered-fields.ts`). They also need to cover its label. Otherwise undoing an owner-asked change would put back the old text marked as the owner's, and it would stick.

A server summary written after an AI edit that changed the summary makes that edit's Undo answer "changed since". That is the existing rule (ROADMAP, #181), and it is accepted. An edit that changed only other fields still undoes, since receipts compare only the fields they changed.

### The web

- On `linkRow` (`src/web/link-rows.ts`), used by All links and space pages, a row with no why shows the summary in the why's place, styled as grey text: one line with an ellipsis on desktop, two lines on a phone.
- A row with a why is unchanged, and so is a row with neither.
- On a space page, a row with no why also keeps its Tell me why. When the owner answers it, the summary line goes as the why appears, so the row never shows both.
- Search results keep showing the summary as they do now.
- The `__ask_off__` byte snapshots change wherever a sample row has no why but has a summary.

### Export

`links.json` carries the label next to `summary`, and re-importing restores it, as the export design asks for the why's source. A file without the label reads as unlabelled, so its summaries are replaced, the same as summaries saved before this change. This is `EXPORT_VERSION` 3: the export design says "Adding a key is a new version" (`docs/specs/2026-10-18-export-design.md`). The reader keeps accepting versions 1 and 2.

### Docs

- README "How it works" says the server needs no AI keys and that the talking AI writes summaries. It now says the server writes them when its AI is set up.
- The `update_link` row gains the summary label.
- ROADMAP gets a dated decision-log entry with the owner decisions above.

## Left to the builder

These are the controller's calls unless a reviewer finds a reason against:

- `SUMMARY_MAX`, about 160 characters, sized for two lines on a phone.
- How much page text goes to the model: about 6,000 characters, from the start of the snapshot text, after the title and description.
- The gap between calls, the per-link backoff, how many failures in a row pause the pass, and the per-call timeout. A local model (#187) is slow, so allow at least 60 s.
- The column shape (above), the migration and the migration test.
- Whether backoff state is kept in memory, as the copy pass keeps it, or in the database.
- The exact prompt wording.

## Landing order

1. **The label:** the column and migration, `Link`, the store, MCP input, output and guidance, Undo receipts, and export. Behaviour is unchanged apart from the label being stored and returned.
2. **The pass:** the summary pass and its wiring in `startServer`. README.
3. **The rows:** `linkRow` shows the summary where there's no why.
