import {
  InMemoryTransport,
  isJSONRPCErrorResponse,
  isJSONRPCResultResponse,
  LATEST_PROTOCOL_VERSION,
} from "@modelcontextprotocol/server";
import type { Caller } from "../auth/caller.js";
import type { Change } from "../mcp/changes.js";
import { buildMcpServer, type McpDeps, type TrackCall } from "../mcp/server.js";
import type { ToolSpec } from "./model.js";

export type ToolResult = { text: string; isError: boolean; structured: unknown };

/** The app's own MCP tools, called in process as one signed-in caller. */
export type ToolSession = {
  /** What the MCP door tells an agent when it connects. */
  instructions: string;
  tools: ToolSpec[];
  /** A refusal comes back as `isError: true`; a call that can't be made at all rejects. */
  call(name: string, args: unknown): Promise<ToolResult>;
  /** What the calls committed so far, in commit order, including calls that then failed. A copy. */
  changes(): Change[];
  close(): Promise<void>;
};

function onlyLastEditId(changes: Change[]): Change[] {
  const lastWith = new Map<string, number>();
  changes.forEach((c, i) => {
    if (c.kind === "link" && c.editId) lastWith.set(c.linkId, i);
  });
  return changes.map((c, i) =>
    c.kind === "link" && c.editId && lastWith.get(c.linkId) !== i ? { ...c, editId: null } : c,
  );
}

type Pending = { resolve: (result: unknown) => void; reject: (error: Error) => void };

/** The MCP server answered a request with a protocol error, not a tool result. */
class RpcError extends Error {}

/**
 * Connects `buildMcpServer` to a client end on an in-memory pair and speaks the MCP handshake
 * itself, so the AI sees the very tools and instructions the MCP door gives an agent.
 */
export async function openToolSession(
  deps: McpDeps,
  caller: Caller,
  track: TrackCall,
): Promise<ToolSession> {
  const changes: Change[] = [];
  const server = buildMcpServer(deps, caller, track, (change) => changes.push(change));
  const [client, serverEnd] = InMemoryTransport.createLinkedPair();
  await server.connect(serverEnd);

  const pending = new Map<number, Pending>();
  let nextId = 1;
  let closed = false;
  // However the link ends, a request waiting for its reply must not wait forever.
  const failPending = (reason: string) => {
    closed = true;
    for (const waiting of pending.values()) waiting.reject(new Error(reason));
    pending.clear();
  };
  client.onmessage = (message) => {
    if (!isJSONRPCResultResponse(message) && !isJSONRPCErrorResponse(message)) return;
    const waiting = pending.get(Number(message.id));
    if (!waiting) return;
    pending.delete(Number(message.id));
    if (isJSONRPCErrorResponse(message)) waiting.reject(new RpcError(message.error.message));
    else waiting.resolve(message.result);
  };
  client.onclose = () => failPending("The tool session is closed.");
  client.onerror = (error) => failPending(`The tool session failed: ${error.message}`);
  await client.start();

  const request = (method: string, params?: Record<string, unknown>) =>
    new Promise<unknown>((resolve, reject) => {
      if (closed) return reject(new Error("The tool session is closed."));
      const id = nextId++;
      pending.set(id, { resolve, reject });
      client
        .send({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) })
        .catch((error: unknown) => {
          pending.delete(id);
          reject(error instanceof Error ? error : new Error(String(error)));
        });
    });

  try {
    const init = (await request("initialize", {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "aye-ai-ai-links in-app AI", version: deps.version ?? "dev" },
    })) as { instructions?: string };
    await client.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    const listed = (await request("tools/list")) as { tools: ToolSpec[] };
    return {
      instructions: init.instructions ?? "",
      tools: listed.tools.map(({ name, description, inputSchema }) => ({
        name,
        description,
        inputSchema,
      })),
      async call(name, args) {
        try {
          const result = (await request("tools/call", { name, arguments: args ?? {} })) as {
            content?: { type: string; text?: string }[];
            isError?: boolean;
            structuredContent?: unknown;
          };
          return {
            text: result.content?.find((part) => part.type === "text")?.text ?? "",
            isError: result.isError === true,
            structured: result.structuredContent ?? null,
          };
        } catch (error) {
          if (error instanceof RpcError) {
            return { text: error.message, isError: true, structured: null };
          }
          throw error;
        }
      },
      changes: () => onlyLastEditId(changes),
      close: () => client.close(),
    };
  } catch (error) {
    await client.close();
    throw error;
  }
}
