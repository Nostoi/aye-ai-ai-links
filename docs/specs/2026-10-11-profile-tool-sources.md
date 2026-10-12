# Profile tools: decisions and their sources

Dated 2026-10-11, for #33. Each decision below cites the documentation it rests on. Quotes are verbatim from pages fetched on 2026-10-11; line breaks inside a quoted sentence are joined. This is a dated record: it is not updated, and a later decision supersedes it in `ROADMAP.md`. It extends `2026-10-11-mcp-door-sources.md`, which covers the transport, Origin checks and authorization.

Sources:

- MCP tools page: https://modelcontextprotocol.io/specification/2026-07-28/server/tools
- MCP `schema.ts` at commit `1f520964b295d58494d944f2aea8a5ab51c79f77`: https://github.com/modelcontextprotocol/modelcontextprotocol/blob/1f520964b295d58494d944f2aea8a5ab51c79f77/schema/2026-07-28/schema.ts
- OpenAI, build an MCP server: https://developers.openai.com/plugins/build/mcp-server.md
- OpenAI, reference: https://developers.openai.com/plugins/reference.md
- Claude Code, MCP (for server authors): https://code.claude.com/docs/en/mcp#for-mcp-server-authors

## Tool hints: `get_profile`, `add_profile`, `edit_profile`

**Decision.** Every tool sets all four hints.

| Tool | readOnly | destructive | idempotent | openWorld |
|---|---|---|---|---|
| `get_profile` | true | false | true | false |
| `add_profile` | false | false | false | false |
| `edit_profile` | false | true | false | false |

**Definitions and defaults** (`ToolAnnotations` in `schema.ts`):

- `readOnlyHint`: "If true, the tool does not modify its environment." "Default: false"
- `destructiveHint`: "If true, the tool may perform destructive updates to its environment. If false, the tool performs only additive updates." "(This property is meaningful only when `readOnlyHint == false`)" "Default: true"
- `idempotentHint`: "If true, calling the tool repeatedly with the same arguments will have no additional effect on its environment." "(This property is meaningful only when `readOnlyHint == false`)" "Default: false"
- `openWorldHint`: "If true, this tool may interact with an "open world" of external entities. If false, the tool's domain of interaction is closed. For example, the world of a web search tool is open, whereas that of a memory tool is not." "Default: true"
- All of them are hints: "NOTE: all properties in `ToolAnnotations` are **hints**. They are not guaranteed to provide a faithful description of tool behavior".
- "Clients should never make tool use decisions based on `ToolAnnotations` received from untrusted servers." The tools page adds: "For trust & safety and security, clients **MUST** consider tool annotations to be untrusted unless they come from trusted servers."

**How they apply.**

- `get_profile` only reads, so `readOnlyHint` is true. `destructiveHint` and `idempotentHint` are set anyway, to the values `search_links` and `get_link` use, so that no default (destructive true) is left in force.
- `add_profile` only inserts, which is `destructiveHint: false`, "additive updates". Repeating a call with the same arguments inserts a second row, so `idempotentHint` is false.
- `edit_profile` replaces note text and deletes notes, which is "destructive updates", so `destructiveHint` is true. Repeating a call with the same arguments can fail or change a note again, so `idempotentHint` is false.
- `openWorldHint` is false for all three. The profile is the spec's own example of a closed world ("a memory tool"), and OpenAI's page says: "A tool limited to a bounded private account or workspace can set this to `false`, even when that service is externally hosted."

**Why `add_profile` and `edit_profile` are two tools (owner ruling, 2026-10-11).**

- OpenAI's page: "Create one tool for each distinct action the plugin must support. Prefer focused operations such as `list_projects`, `get_project`, and `update_project` over one tool with many unrelated modes."
- OpenAI's reference describes `destructiveHint` as: "Declare that the tool may delete or overwrite user data so the host knows to elicit explicit approval first." A routine "the owner is working on X" would otherwise go through a tool that hosts may gate harder than it needs.
- OpenAI's page, on what annotations are for: "Annotations help ChatGPT and Codex choose appropriate confirmation and safety behavior. They do not replace authorization, validation, or confirmation in your server." So the stated-note rule and the length caps are enforced in `core/profile.ts`, not left to the hints.

## `get_profile` takes no arguments

**Decision.** `get_profile` declares `z.strictObject({})`, which advertises `"additionalProperties": false`.

- Tools page: "`inputSchema` ... **MUST** be a valid JSON Schema object (not `null`)" and "For tools with no parameters, use one of these valid approaches:" "`{ "type": "object", "additionalProperties": false }` - **Recommended**: explicitly accepts only empty objects".
- Consequence: a stray argument such as `owner` is refused with a tool error. The other tools strip unknown keys instead. Both are safe, because the owner comes from the authenticated caller and never from arguments.

## Results and errors

**Decision.** Results are plain objects with a stable shape, returned as `structuredContent` and as the same JSON in a text block. Core errors are returned as tool errors with a message the agent can act on.

- Tools page: "For backwards compatibility, a tool that returns structured content SHOULD also return the serialized JSON in a TextContent block."
- Tools page, tool execution errors: "Input validation errors (e.g., date in wrong format, value out of range)" and "Business logic errors" are both execution errors, and "Clients **SHOULD** provide tool execution errors to language models to enable self-correction."
- A write tool returns the profile as it stood inside the same database transaction, with the new ids, and does no second read. A read after a committed write could fail, report the write as failed, and invite a retry that adds the note twice.
- `outputSchema` is not declared here. Tools page: "`outputSchema`: Optional JSON Schema defining expected output structure". A separate issue (#39) adds it to every tool, and the owner wants that first.

## Descriptions and instructions

**Decision.** Each description opens with when to use the tool and keeps the key rule near the start. The new profile paragraph in `INSTRUCTIONS` goes after the existing text.

- Claude Code: "Claude Code truncates each tool description and each server's instructions at 2,048 characters by default. Keep them concise, and put critical details near the start."
- OpenAI, on server instructions: "Keep the most important details in the first 512 characters."
- The existing length test in `src/mcp/http.test.ts` covers the new descriptions.
