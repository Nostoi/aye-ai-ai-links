# MCP door: decisions and their sources

Dated 2026-10-11, for #5 and #6. Each decision below cites the documentation it rests on. Quotes are verbatim, fetched on 2026-10-11. This is a dated record: it is not updated, and a later decision supersedes it in `ROADMAP.md`.

## Protocol revisions

**Decision:** serve the 2026-07-28 revision and the 2025-era revisions from one endpoint. `createMcpHandler` keeps its default, `legacy: 'stateless'`.

- **Current revision.** The current revision is 2026-07-28: "The **current** protocol version is [**2026-07-28**]". Source: https://modelcontextprotocol.io/docs/2026-07-28/learn/versioning
- **What changed.** The 2026-07-28 changelog says:
  - "Make MCP stateless: remove the `initialize`/`notifications/initialized` handshake."
  - "Add `server/discover`: servers MUST implement this RPC".

  Source: https://modelcontextprotocol.io/specification/2026-07-28/changelog
- **Codex still sends the 2025 handshake.** It sends 2025-06-18 with `initialize` unless an under-development feature flag is on:
  - `protocol_mode.rs` (`Legacy` maps to `ProtocolVersion::V_2025_06_18`): https://github.com/openai/codex/blob/be2e4afcd7392339d6adbaf0d31b26316bcaa2ab/codex-rs/rmcp-client/src/protocol_mode.rs#L8-L33
  - The feature flag `mcp_2026_07_28` is `default_enabled: false`: https://github.com/openai/codex/blob/6c0c6759d0617d7670826b61aca0a931bbb6db1f/codex-rs/features/src/lib.rs#L1530-L1534
- **Older clients on the current transport.** The current transport says: "HTTP GET or DELETE to the MCP endpoint: respond with `405 Method Not Allowed`." Source: https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http
- **Stateless serving is allowed in 2025-11-25 too.**
  - "A server using the Streamable HTTP transport **MAY** assign a session ID at initialization time".
  - Per the same 2025-11-25 transport page, a server may answer GET and DELETE with 405.

  Source: https://modelcontextprotocol.io/specification/2025-11-25/basic/transports
- **SDK trap.** In `@modelcontextprotocol/core` 2.3.1, the exported `LATEST_PROTOCOL_VERSION` is `2025-11-25`. The server package serves 2026-07-28 through a separate internal list. This was observed in the package's built files.

## Origin and Host validation

**Decision:** the `/mcp` app validates both Host and Origin. A request whose Origin is present and not allowed gets a 403.

- "Servers **MUST** validate the `Origin` header on all incoming connections to prevent DNS rebinding attacks."
- "If the `Origin` header is present and invalid, servers **MUST** respond with HTTP 403 Forbidden."
- "When running locally, servers **SHOULD** bind only to localhost (127.0.0.1) rather than all network interfaces (0.0.0.0)."

Source: https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http

## Authorization: a static bearer key for Claude Code and Codex in phases 1–2

**Decision:** for now, `/mcp` accepts a per-agent bearer key (#6) and refuses everything else with a 401. This is a deliberate departure from a SHOULD. Phase 3 adds OAuth 2.1 per the MCP authorization spec, before Funnel and before ChatGPT.

- **Authorization is optional, and OAuth is a SHOULD for HTTP.** "Authorization is **OPTIONAL** for MCP implementations." "Implementations using an HTTP-based transport **SHOULD** conform to this specification." Source: https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization
- **What the spec requires when its authorization is used:**
  - "Invalid or expired tokens **MUST** receive a HTTP 401 response."
  - "Access tokens **MUST NOT** be included in the URI query string".

  Our keys travel only in the `Authorization` header. Source: same page.
- **The spec's security guidance.** For local servers using an HTTP transport, it recommends "Require an authorization token". Source: https://modelcontextprotocol.io/docs/2026-07-28/tutorials/security/security_best_practices
- **The spec does not define static keys.** No spec text or published extension defines static API keys. The extension list is at https://github.com/modelcontextprotocol/ext-auth.
- **ChatGPT cannot use this key.** "ChatGPT does **not** support machine-to-machine OAuth grants such as client credentials, service accounts, or JWT bearer assertions, nor can it present custom API keys or customer-provided mTLS certificates." It needs no-auth or OAuth 2.1. Source: https://developers.openai.com/plugins/build/auth.md
- **Claude Code sends a static bearer header.** `claude mcp add --transport http <name> <url> --header "Authorization: Bearer <token>"`. Source: https://code.claude.com/docs/en/mcp
- **Codex sends one from an environment variable.** It uses `[mcp_servers.<name>]` with `url` and `bearer_token_env_var`. Source: https://learn.chatgpt.com/docs/extend/mcp.md#streamable-http-servers

## Server instructions

**Decision:** the server sets `instructions`, which the SDK serves in both eras. It is kept under 2,048 characters, with the why rule and tag reuse in the first 512.

- **2026-07-28.** `instructions` is part of the `server/discover` result: "Optional natural-language guidance for LLMs on how to use this server effectively". Source: https://modelcontextprotocol.io/specification/2026-07-28/server/discover
- **2025-11-25.** It is in `InitializeResult.instructions`. Source: https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle
- **Claude Code's limit.** "Claude Code truncates each tool description and each server's instructions at 2,048 characters by default." Source: https://code.claude.com/docs/en/mcp#for-mcp-server-authors
- **OpenAI's advice.** "Keep the most important details in the first 512 characters." Source: https://developers.openai.com/plugins/build/mcp-server.md

## Tool annotations

**Decision:** every tool sets all four hints.

| Tool | readOnly | destructive | idempotent | openWorld |
|---|---|---|---|---|
| `save_link` | false | false | true | false |
| `update_link` | false | true | false | false |
| `search_links` | true | false | true | false |
| `get_link` | true | false | true | false |

- **Defaults.** The spec defaults are readOnlyHint `false`, destructiveHint `true`, idempotentHint `false` and openWorldHint `true` (`ToolAnnotations` in schema.ts). A tool that leaves out a hint gets the riskiest reading.
  - destructiveHint: "If false, the tool performs only additive updates."
  - openWorldHint: "If false, the tool's domain of interaction is closed."

  Source: https://modelcontextprotocol.io/specification/2026-07-28/server/tools
- **Why `update_link` is destructive.** It can clear or replace a summary, why and tags.
- **Why `update_link` is not idempotent.** `opened: true` stamps a new time on each call.
- **OpenAI.** It marks `readOnlyHint`, `destructiveHint` and `openWorldHint` as "Required" (https://developers.openai.com/plugins/reference.md). It also says that "Annotations help ChatGPT and Codex choose appropriate confirmation and safety behavior" (https://developers.openai.com/plugins/build/mcp-server.md).
  - Whether ChatGPT skips confirmation for read-only tools rests only on an archived page from January 2026. The phase 1b spike settles it.

## Results and errors

**Decision:**
- Results carry `structuredContent` plus the same JSON as text.
- A bad input or a failure in core comes back as a tool result with `isError: true`, in words an agent can act on.
- An unknown tool is a protocol error. The SDK handles that.

- **Results:** "For backwards compatibility, a tool that returns structured content SHOULD also return the serialized JSON in a TextContent block."
- **Tool errors:** tool execution errors (`isError: true`) cover "Input validation errors (e.g., date in wrong format, value out of range)" and "Business logic errors". "Clients **SHOULD** provide tool execution errors to language models to enable self-correction."

Source: https://modelcontextprotocol.io/specification/2026-07-28/server/tools
