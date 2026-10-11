# update_tag: decisions and their sources

Dated 2026-10-11, for #23. Each decision below cites the documentation it rests on. Quotes are verbatim, fetched on 2026-10-11. This is a dated record: it is not updated, and a later decision supersedes it in `ROADMAP.md`. It follows `2026-10-11-mcp-door-sources.md`, which holds the door-wide decisions.

## Name: `update_tag`

**Decision:** the tool is `update_tag`. It follows the issue's example and pairs with `update_link`.

- The MCP naming rules: "Tool names **SHOULD** be between 1 and 128 characters in length (inclusive)." "The following **SHOULD** be the only allowed characters: uppercase and lowercase ASCII letters (A-Z, a-z), digits (0-9), underscore (\_), hyphen (-), and dot (.)" "Tool names **SHOULD** be unique within a server." Source: https://modelcontextprotocol.io/specification/2026-07-28/server/tools ("Tool Names").
- OpenAI: "Prefer focused operations such as `list_projects`, `get_project`, and `update_project` over one tool with many unrelated modes." and "An action-oriented name and human-readable title." Source: https://developers.openai.com/plugins/build/mcp-server.md ("Define tools from user goals").

## Input schema: `{name, kind}`

**Decision:** both fields are required. `kind` is the enum `topic | project`. The door validates it with zod and core validates it again, because phase 4 calls core without zod.

- `inputSchema` is a "JSON Schema defining expected parameters", "**MUST** be a valid JSON Schema object (not `null`)", and "Defaults to 2020-12 if no `$schema` field is present". Source: https://modelcontextprotocol.io/specification/2026-07-28/server/tools ("Tool").
- "Servers **MUST**: Validate all tool inputs". Source: same page ("Security Considerations").
- OpenAI asks for "An explicit input schema." Source: https://developers.openai.com/plugins/build/mcp-server.md ("Define tools from user goals").

## Hints: `readOnlyHint: false`, `destructiveHint: true`, `idempotentHint: true`, `openWorldHint: false`

**Decision:** all four are set, because the defaults are the riskiest reading. Source for the definitions: `ToolAnnotations` in `schema.ts` at commit `1f520964b295d58494d944f2aea8a5ab51c79f77`, https://github.com/modelcontextprotocol/modelcontextprotocol/blob/1f520964b295d58494d944f2aea8a5ab51c79f77/schema/2026-07-28/schema.ts#L1900-L1954.

- `readOnlyHint: false`. "If true, the tool does not modify its environment. Default: false". The tool writes the tag catalog.
- `destructiveHint: true`. "If true, the tool may perform destructive updates to its environment. If false, the tool performs only additive updates. … Default: true". A kind change overwrites a value and can drop a project's done status, so it is not additive. The owner's ruling on #23 asks for it too. OpenAI's wording ("`true` when a tool can cause irreversible or difficult to reverse outcomes") fits less well, since a kind is reversible. The spec's "only additive" test decides it.
- `idempotentHint: true`. "If true, calling the tool repeatedly with the same arguments will have no additional effect on its environment. (This property is meaningful only when `readOnlyHint == false`) Default: false". The first call sets kind K and clears the status. A second identical call finds kind K and writes nothing.
- `openWorldHint: false`. "If true, this tool may interact with an "open world" of external entities. If false, the tool's domain of interaction is closed. For example, the world of a web search tool is open, whereas that of a memory tool is not. Default: true". The tool touches only the owner's catalog.
- The hints enforce nothing. The same file says: "NOTE: all properties in `ToolAnnotations` are **hints**." and "Clients should never make tool use decisions based on `ToolAnnotations` received from untrusted servers." OpenAI says: "Annotations help ChatGPT and Codex choose appropriate confirmation and safety behavior. They do not replace authorization, validation, or confirmation in your server." Source: https://developers.openai.com/plugins/build/mcp-server.md ("Tool annotations and elicitation"). So the "only when the owner says so" rule is in the description, and owner scoping is in the store.

## Description

**Decision:** plain sentences, the when-to-use rule first, and no repetition of the server instructions. It discloses that turning a project into a topic and back clears "done".

- The spec: "A human-readable description of the tool. This can be used by clients to improve the LLM's understanding of available tools. It can be thought of like a "hint" to the model." Source: `Tool.description` in `schema.ts`, same commit, L1974-1979.
- OpenAI: "A description that explains when to use it." Source: https://developers.openai.com/plugins/build/mcp-server.md.
- Claude Code: "Claude Code truncates each tool description and each server's instructions at 2,048 characters by default. Keep them concise, and put critical details near the start." Source: https://code.claude.com/docs/en/mcp ("Tool search for MCP server authors").

## Results and errors

**Decision:** the result is `{tag}`, as `structuredContent` plus the same JSON as text. There is no output schema, as for the four existing tools. An unknown tag, a blank name and a lost race come back as `isError: true` with core's message. A missing argument or a kind other than `topic` or `project` is refused by the SDK's input validation first, so it comes back as `isError: true` with the SDK's message.

- "For backwards compatibility, a tool that returns structured content SHOULD also return the serialized JSON in a TextContent block." Source: https://modelcontextprotocol.io/specification/2026-07-28/server/tools ("Structured Content").
- Tool execution errors cover "Input validation errors (e.g., date in wrong format, value out of range)" and "Business logic errors", and "Clients **SHOULD** provide tool execution errors to language models to enable self-correction." Source: same page ("Error Handling").
