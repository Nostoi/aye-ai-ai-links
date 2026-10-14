# list_links: decisions and their sources

Dated 2026-10-14, for #37. Each decision below cites the documentation it rests on. Quotes are verbatim, fetched on 2026-10-14, except where a quote is marked as relayed. This is a dated record: it is not updated, and a later decision supersedes it in `ROADMAP.md`. It follows `2026-10-11-mcp-door-sources.md`, which holds the door-wide decisions.

## A new tool, not a wider `search_links`

**Decision:** listing and counting are a new read-only tool, `list_links`. `search_links` keeps its input and output; only its description changes, to point to the new tool.

- OpenAI: "Prefer focused operations such as `list_projects`, `get_project`, and `update_project` over one tool with many unrelated modes." Source: https://developers.openai.com/plugins/build/mcp-server.md ("Define tools from user goals"). The full sentence is relayed from `2026-10-11-update-tag-sources.md`; the fetch on 2026-10-14 confirmed its start.
- OpenAI: "Add fields or tools without breaking existing contracts." Source: same page ("Plan for updates").

## The cursor is a tool argument, not MCP pagination

**Decision:** `list_links` takes `cursor` and returns `nextCursor`, which is null on the last page. The cursor is opaque to the AI, and the server checks it on every use.

- MCP pagination covers list operations only: "The following MCP operations support pagination: `resources/list` … `resources/templates/list` … `prompts/list` … `tools/list`". Source: https://modelcontextprotocol.io/specification/2026-07-28/server/utilities/pagination ("Operations Supporting Pagination"). A tool's result is not among them, so the cursor is an ordinary tool argument.
- The same page shows the model the tool's names follow: "The **cursor** is an opaque string token, representing a position in the result set", and the server returns "An optional `nextCursor` field if more results exist". Source: same page ("Pagination Model", "Response Format").
- The Tools page treats a value carried from one call to the next as an ordinary string: "from the wire's perspective a handle is an ordinary string in a tool result and an ordinary argument to subsequent tool calls." It advises: "**Opacity.** Handles that encode internal structure invite parsing or guessing; opaque identifiers do not." Source: https://modelcontextprotocol.io/specification/2026-07-28/server/tools ("Stateful Tools", non-normative). The cursor's form is readable, but the description says never to build or change one, and the server refuses any cursor that doesn't name one of the caller's own links.

## A cursor that does not fit is a tool execution error

**Decision:** a malformed cursor, one made for another order, and one naming no link of the caller come back as `isError: true` with core's message, which says to list again without it.

- The Pagination page says: "Invalid cursors **SHOULD** result in an error with code -32602 (Invalid params)." Source: Pagination page ("Error Handling"). That rule is for the list operations the page covers. `list_links` is a tool call, so the Tools page governs it.
- "**Expiry errors.** A call against an expired or unknown handle should return a tool execution error that says so, so the model can recover by creating a new one." Source: Tools page ("Stateful Tools").
- Tool execution errors cover "Input validation errors (e.g., date in wrong format, value out of range)" and "Business logic errors", and "Clients **SHOULD** provide tool execution errors to language models to enable self-correction." Source: Tools page ("Error Handling").

## Hints: `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: false`

**Decision:** the same hints as `search_links` and `get_link`. Listing writes nothing, not even the search log, and reads only the caller's library. The definitions are those cited in `2026-10-11-update-tag-sources.md`.
