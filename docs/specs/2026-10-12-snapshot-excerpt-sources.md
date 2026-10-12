# Snapshot excerpt and page text: decisions and their sources

Dated 2026-10-12, for #31. Quotes are verbatim, fetched on 2026-10-12. This is a dated record: it is not updated, and a later decision supersedes it in `ROADMAP.md`. The owner's rulings and the disposition of Codex's challenge are in #31 comment 6118791899.

## `save_link` waits up to 4 s for a new link's page

**Decision:** core `saveLink` keeps the snapshot runner's kick promise and races it against a timer (`SAVE_WAIT_MS = 4_000` in `src/core/links.ts`, overridable through `Deps.saveWaitMs`). The timer is cleared whichever side wins. Then the link is read again, so the result shows the page's status, title, description and image, and any edit made during the wait. A repeat save never kicks and never waits.

4 s sits far inside every client timeout found:

- Neither the MCP Tools page nor its Cancellation page gives a number. Tools page, client duties: "Implement timeouts for tool calls." Source: https://modelcontextprotocol.io/specification/2026-07-28/server/tools ("Security Considerations").
- Cancellation page: "Implementations **SHOULD** establish timeouts for all sent requests, to prevent hung connections and resource exhaustion." Source: https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/cancellation ("Timeouts").
- Claude Code: "Claude Code sets that timer to the greatest of three values: 60 seconds, the tool timeout that applies to the server, and `MCP_TIMEOUT`." and "The idle window defaults to five minutes for HTTP, SSE, WebSocket, and claude.ai connector servers". Source: https://code.claude.com/docs/en/mcp.
- Codex: "Timeout (seconds) for the server to run a tool. Default: `60`." Source: https://learn.chatgpt.com/docs/extend/mcp?surface=cli (`tool_timeout_sec`).
- MCP TypeScript SDK 2.3.1: `DEFAULT_REQUEST_TIMEOUT_MSEC = 6e4` (`node_modules/@modelcontextprotocol/server/dist/src-Cqbh3MYc.mjs`). That SDK-based hosts use this default is not checked.

A client that gives up and disconnects cancels the request: "The server **MUST** treat a client disconnect as cancellation of that request." (Cancellation page, "Transport-Specific Cancellation".) The save has already committed by then, so a retry returns the same link with `created: false`.

**What `pending` means.** A settled kick does not prove the outcome was stored: a record that fails after extraction leaves the row `pending`, and so does a save during shutdown or a wait that runs out. So the guidance says `pending` means "not fetched yet; call `get_link` later", not "still being fetched".

**No new status.** Adding an enum value breaks a validating client holding an earlier `tools/list` (ROADMAP, #39 entry), and `pending` already covers "not finished".

## `snapshotText`: text read only when the snapshot is ok

**Decision:** `save_link` and `get_link` return `snapshotText: {text, truncated} | null`, built in one place, `src/core/snapshot-text.ts`. `snapshotOutput` is unchanged: `Link.snapshot` still never carries text.

- The text is read only when the link's own captured `snapshot.status` is `ok`. Only an ok extraction stores text, and ok is final, so the status and the text describe the same moment. Without this rule, an extraction that finishes between the link read and the text read gives `pending` with text (Codex, RAN).
- Caps: 500 code points for `save_link`, 20,000 for `get_link`. A cap counts code points and never splits a surrogate pair. `truncated` is always present.
- `get_link` has its own `getLinkOutput`; `update_link` keeps `linkResultOutput`. `search_links` and `update_link` never read text.

**Additive for cached clients.** `snapshotText` is a new top-level key. `tools/list` advertises open objects, so a client that cached the earlier list accepts it. A test compiles main's pre-#31 `save_link` and `get_link` schemas (`src/mcp/fixtures/pre-31-output-schemas.json`) with the v1 client's Ajv options and validates real results that carry text, in both protocol eras. The spec rule it serves: "Clients **SHOULD** validate structured results against this schema." (Tools page, "Output Schema".)

## The 20,000 cap and Claude Code's 50,000-character limit

**Decision:** the cap bounds the text, not the whole result. Inline delivery in Claude Code is the expected outcome for ordinary pages, not a guarantee.

- Claude Code: "for a tool that doesn't declare `anthropic/maxResultSizeChars`, Claude Code saves a successful result with no image content to a file once it's longer than 50,000 characters, whatever its token count. Setting `MAX_MCP_OUTPUT_TOKENS` doesn't change this threshold". Also: "Claude Code displays a warning when MCP tool output exceeds 10,000 tokens and limits output to 25,000 tokens by default." Source: https://code.claude.com/docs/en/mcp.
- Not stated there: whether the 50,000 counts the text block, `structuredContent`, or both, and in which unit. The server sends both: "For backwards compatibility, a tool that returns structured content SHOULD also return the serialized JSON in a TextContent block." (Tools page, "Structured Content".)
- What can still pass 50,000: JSON escapes control characters (Codex measured 70,426 characters for a page of `x\u0000` pairs), and `update_link` sets no length limit on a title (`updateLinkInput` in `src/mcp/server.ts`, `updateLink` in `src/core/links.ts`, `SqliteStore.update`; Codex measured 60,380 characters for a 60,000-character title). A door test checks only a sanity bound: ordinary prose capped at 20,000 gives a text block of at most 50,000 characters.
- Owner ruling Q3: keep 20,000, and check it live at the next deploy with `get_link` on a long page (the issue's Wikipedia example) in Claude Code. Lower the cap only if the result goes to a file.

## Hints unchanged

- `save_link` stays `idempotentHint: true`: "If true, calling the tool repeatedly with the same arguments will have no additional effect on its environment." A repeat save never fetches, and a result that shows more later is not an effect. Source: `ToolAnnotations` in https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/main/schema/2026-07-28/schema.ts.
- `openWorldHint: true` was set in #30: "If true, this tool may interact with an "open world" of external entities." (Same source.)

## Failures after the commit

There is no special handling. If a read after the commit fails (the re-read, `filingContext` or `profile`), the call reports "try again". A retry is safe: it returns the saved link with `created: false`. The ruling that "a background failure cannot fail a committed save" is about the background job: `kick` never rejects, and that is unchanged.
