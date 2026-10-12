# Output schemas: decisions and their sources

Dated 2026-10-11, for #39. Quotes are verbatim, fetched on 2026-10-11. This is a dated record: it is not updated, and a later decision supersedes it in `ROADMAP.md`. It supersedes the "There is no output schema" sentence in `2026-10-11-update-tag-sources.md` ("Results and errors") and leaves the rest of `2026-10-11-mcp-door-sources.md` standing, including "An unknown tool is a protocol error. The SDK handles that."

## Declare an `outputSchema` on every tool

**Decision:** all five tools declare one, built in `src/mcp/output-schemas.ts` with zod. The SDK turns it into JSON Schema for `tools/list`, in both protocol eras.

- OpenAI's MCP guide: "An output schema when the tool returns structured data." Source: https://developers.openai.com/plugins/build/mcp-server.md ("Define tools from user goals").
- OpenAI's reference: "Declare `outputSchema` for any tool that returns `structuredContent`. The schema should describe the exact object your tool returns so clients can validate results and the model can reason about follow-up tool calls." Source: https://developers.openai.com/plugins/reference.md. (The issue's quote "help ChatGPT and Codex" is from a different sentence and is about annotations: "Annotations help ChatGPT and Codex choose appropriate confirmation and safety behavior.")
- The MCP spec: "Tools may also provide an output schema for validation of structured results. If an output schema is provided:" "Servers **MUST** provide structured results that conform to this schema." "Clients **SHOULD** validate structured results against this schema." Source: https://modelcontextprotocol.io/specification/2026-07-28/server/tools ("Output Schema"). The 2025-11-25 and 2025-06-18 tools pages carry the same two bullets.
- Every tool already returned `structuredContent` and the same JSON as a text block. The spec: "For backwards compatibility, a tool that returns structured content SHOULD also return the serialized JSON in a TextContent block." (Same page, "Structured Content".) Nothing about a call result changes.
- The root is `type: "object"`, which the 2025 schemas require: "Currently restricted to type: "object" at the root level." Source: `outputSchema` in https://github.com/modelcontextprotocol/modelcontextprotocol/blob/c4c367f9f58296a7053f5c78a52fd02bfbb56a49/schema/2025-11-25/schema.ts. A non-object root would make SDK 2.3.1 wrap the result for 2025 clients (`legacyWrap`, `src-Cqbh3MYc.mjs` in `node_modules/@modelcontextprotocol/server/dist/`), so a test asserts the root type.
- Codex, on an unreleased `main` (`openai/codex@a9b0815167c27ab13719dd12d13b63e02b70d221`), gives the model `structured_content` serialized as text in place of the content blocks, unless the content has an encrypted item: `as_function_call_output_payload` in https://github.com/openai/codex/blob/a9b0815167c27ab13719dd12d13b63e02b70d221/codex-rs/protocol/src/models.rs#L2414-L2448. Declaring a schema does not change that, because `structuredContent` was already sent.
- Not checked: that released Codex, Claude Code and Claude Desktop accept the new `tools/list`. That rides with the real-client check after deploy (#7, #27).

## Timestamps are plain strings

**Decision:** every timestamp field is `z.string()`, not `z.iso.datetime()`.

- `ok()` serializes with `Date#toJSON`. The door accepts `snoozedUntil: "9999-12-31T23:59:59-01:00"`, which serializes as `+010000-01-01T00:59:59.000Z`, and `"0000-01-01T00:00:00+01:00"`, which serializes as `-000001-12-31T23:00:00.000Z` (both printed by `node`). Neither is a four-digit ISO year, so an ISO check would turn a committed write into an error and break every later read of that link.
- The tests save both values and then read them back through `get_link`, `search_links` and a repeat `save_link`.
- The compile-time tie checks field names, nullability and enums. It cannot see the values a field may take, so nothing here claims a mismatch is unreachable.

## Strict in the server, open in `tools/list`

**Decision** (issue comment 6115694120, superseding point 2 of comment 6115445970): every object in an output schema is `z.strictObject`, and `guarded` checks each result against it. `tools/list` shows the same schema with every `additionalProperties: false` removed (`advertisedOpen` in `output-schemas.ts`), so a client accepts extra keys. Enums are left closed.

- zod advertises `additionalProperties: false` for `z.object` output too, but SDK 2.3.1 lets extra keys through when it checks a result. Probe: a result with extra keys returned success, Ajv run on the advertised schema refused it ("data must NOT have additional properties"), and `z.strictObject` made the SDK refuse it too ("Unrecognized key").
- **Why open:** per comment 6115694120, the TS SDK v1 client caches each tool's output validator when it lists tools. Ajv with that client's options as the reviewer's probe set them (`strict: false`, `validateFormats: true`, `validateSchema: false`, `allErrors: true`, plus `ajv-formats`; the same options SDK 2.3.1's `createDefaultAjvInstance` uses) refused a real `save_link` result with a key added to each object, under the strict schema: "data must NOT have additional properties". A field added in a deploy would then break each such session opened before it, after any write had committed. Whether Claude Code, Codex and Claude Desktop validate this way is not checked. OpenAI's guide says: "Keep published tool names and schemas backward compatible. Add fields or tools without breaking existing contracts." Source: https://developers.openai.com/plugins/build/mcp-server.md.
- **One definition per shape:** SDK 2.3.1 builds the `tools/list` schema from `~standard.jsonSchema.output` (`convertOutputSchemaJson`, `mcp-DIH4cS6P.mjs`) and checks results with `~standard.validate` (`validateStandardSchema`, `src-Cqbh3MYc.mjs`). `advertisedOpen` changes only the first, so the SDK's own check stays strict. In `server.ts`, `register` takes each tool's schema once and passes it to both `registerTool` and `guarded`.
- **Added fields:** #30's `snapshot` on `Link` and #33's `profile` key on `save_link` are the first. Each still updates the strict schema, but a validating client holding an earlier list still accepts the result.
- **Enums:** adding an enum value still changes the contract, because a validating client holding an earlier list refuses the new value. #30's snapshot statuses are the first case.
- **Tests:** in both eras, Ajv with the v1 client's options, compiled from `tools/list`, accepts a real result of every tool with a key added to every object in it, and the `get_link` schema refuses an unknown `state`.

## Errors stay text-only

**Decision:** an error result has `isError: true` and one text block, and no `structuredContent`.

- The SDK does not check output for `isError` results (`validateToolOutput`: `if (result.isError) return;`, `mcp-DIH4cS6P.mjs` in the SDK's `dist/`).
- The spec wants tool errors visible to the model: "Any errors that originate from the tool SHOULD be reported inside the result object, with `isError` set to true, _not_ as an MCP protocol-level error response. Otherwise, the LLM would not be able to see that an error occurred and self-correct." Source: `CallToolResult.isError` in https://github.com/modelcontextprotocol/modelcontextprotocol/blob/271ecc9accafdd9b83a3c869fa67c22953b2af80/schema/2026-07-28/schema.ts.
- An error with `structuredContent` would also replace our text for Codex's model (see above).
- An unknown tool is not a tool result: the SDK throws `ProtocolError(InvalidParams, "Tool … not found")` before its tool-error handling, and the client gets JSON-RPC code -32602. A test asserts this in both eras.

## A result that breaks its schema after a write

**Decision:** `guarded` checks each payload against its tool's own schema before returning it. On a mismatch it logs with `console.error` and returns an `isError` text result saying the change was saved and must not be retried.

- The SDK runs the handler, then `validateToolOutput`, then projects the result (`mcp-DIH4cS6P.mjs`, the `tools/call` handler). A mismatch there comes back as the SDK's "Output validation error: …" text, is not logged, and arrives after the write has committed (probe: `writes delta 1`).
- Our check returns an `isError` result, which the SDK then skips, so the agent never sees that bare message after a committed write.
- The message is the same for read tools, so it says "any change you asked for was saved".
- A test forces an extra key on `update_link`'s link, and in a second case inside a tag, and asserts the log names the key, the message, one store write, and the committed row.

## Hand-off to #33

- #33's tools are `get_profile`, `add_profile` and `edit_profile`. Each declares a strict schema from the exports of `output-schemas.ts` and registers through `register`, and `save_link`'s `profile` key extends `saveLinkOutput`.
- #33's earlier decision of "no `outputSchema`" is superseded by this issue.
- The test enumerates `tools/list`, so a new tool without an `outputSchema` or without samples fails it.
