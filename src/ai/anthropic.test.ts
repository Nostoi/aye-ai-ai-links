import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { anthropicModel } from "./anthropic.ts";
import { AiUnavailable, type Fetch, type ModelRequest } from "./model.ts";

const KEY = "sk-secret-key-123";
const CONFIG = { url: "https://ai.example", key: KEY, model: "m1", name: "Helper" };

type Seen = { url: string; init: RequestInit };

function fake(status: number, body: unknown): { fetchImpl: Fetch; seen: Seen[] } {
  const seen: Seen[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  }) as unknown as Fetch;
  return { fetchImpl, seen };
}

function reply(content: unknown[], extra: Record<string, unknown> = {}) {
  return { content, ...extra };
}

function request(over: Partial<ModelRequest> = {}): ModelRequest {
  return {
    system: "S",
    messages: [{ role: "user", text: "hi" }],
    tools: [],
    signal: new AbortController().signal,
    ...over,
  };
}

function sentHeaders(seen: Seen[]) {
  return (seen[0]?.init.headers ?? {}) as Record<string, string>;
}

function sentBody(seen: Seen[]) {
  return JSON.parse(String(seen[0]?.init.body));
}

async function failure(fetchImpl: Fetch, req = request()): Promise<AiUnavailable> {
  try {
    await anthropicModel(CONFIG, fetchImpl).reply(req);
  } catch (error) {
    expect(error).toBeInstanceOf(AiUnavailable);
    return error as AiUnavailable;
  }
  throw new Error("expected AiUnavailable");
}

describe("anthropicModel", () => {
  it("posts to <url>/v1/messages with x-api-key, the version header, system, max_tokens and tools", async () => {
    const { fetchImpl, seen } = fake(200, reply([{ type: "text", text: "ok" }]));
    const inputSchema = { type: "object", properties: { q: { type: "string" } } };
    await anthropicModel({ ...CONFIG, url: "https://ai.example/" }, fetchImpl).reply(
      request({ tools: [{ name: "find", description: "Finds", inputSchema }] }),
    );
    expect(seen[0]?.url).toBe("https://ai.example/v1/messages");
    expect(seen[0]?.init.method).toBe("POST");
    expect(sentHeaders(seen)["x-api-key"]).toBe(KEY);
    expect(sentHeaders(seen)["anthropic-version"]).toBe("2023-06-01");
    expect(seen[0]?.init.redirect).toBe("error");
    const body = sentBody(seen);
    expect(body.model).toBe("m1");
    expect(body.system).toBe("S");
    // Thinking counts toward max_tokens, and above 21,333 the docs ask for streaming.
    expect(body.max_tokens).toBe(16_000);
    expect(body.messages).toEqual([{ role: "user", content: "hi" }]);
    expect(body.tools[0]).toEqual({
      name: "find",
      description: "Finds",
      input_schema: inputSchema,
    });
  });

  it("sends no x-api-key header without a key, and no tools field without tools", async () => {
    const { fetchImpl, seen } = fake(200, reply([{ type: "text", text: "ok" }]));
    await anthropicModel({ ...CONFIG, key: undefined }, fetchImpl).reply(request());
    expect(sentHeaders(seen)).not.toHaveProperty("x-api-key");
    expect(sentBody(seen)).not.toHaveProperty("tools");
  });

  it("sends a tool call as a tool_use block and its result as a tool_result in the next user message", async () => {
    const { fetchImpl, seen } = fake(200, reply([{ type: "text", text: "ok" }]));
    await anthropicModel(CONFIG, fetchImpl).reply(
      request({
        messages: [
          { role: "user", text: "find x" },
          {
            role: "assistant",
            text: "looking",
            toolCalls: [
              { id: "c1", name: "find", arguments: { q: "x" } },
              { id: "c2", name: "find", arguments: { q: "y" } },
            ],
          },
          { role: "tool", callId: "c1", name: "find", text: "r1", isError: false },
          { role: "tool", callId: "c2", name: "find", text: "r2", isError: true },
          { role: "user", text: "thanks" },
        ],
      }),
    );
    expect(sentBody(seen).messages).toEqual([
      { role: "user", content: "find x" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "looking" },
          { type: "tool_use", id: "c1", name: "find", input: { q: "x" } },
          { type: "tool_use", id: "c2", name: "find", input: { q: "y" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "c1", content: "r1" },
          { type: "tool_result", tool_use_id: "c2", content: "r2", is_error: true },
        ],
      },
      { role: "user", content: "thanks" },
    ]);
  });

  it("sends an assistant turn of only tool calls without an empty text block", async () => {
    const { fetchImpl, seen } = fake(200, reply([{ type: "text", text: "ok" }]));
    await anthropicModel(CONFIG, fetchImpl).reply(
      request({
        messages: [
          { role: "user", text: "go" },
          { role: "assistant", text: "", toolCalls: [{ id: "c1", name: "f", arguments: {} }] },
        ],
      }),
    );
    expect(sentBody(seen).messages[1].content).toEqual([
      { type: "tool_use", id: "c1", name: "f", input: {} },
    ]);
  });

  it("reads text blocks joined and tool_use blocks as calls", async () => {
    const { fetchImpl } = fake(
      200,
      reply([
        { type: "text", text: "look" },
        { type: "text", text: "ing" },
        { type: "tool_use", id: "c1", name: "find", input: { q: "x" } },
      ]),
    );
    const out = await anthropicModel(CONFIG, fetchImpl).reply(request());
    expect(out.text).toBe("looking");
    expect(out.toolCalls).toEqual([{ id: "c1", name: "find", arguments: { q: "x" } }]);
  });

  it("reads token usage when the reply has it", async () => {
    const withUsage = fake(
      200,
      reply([{ type: "text", text: "a" }], { usage: { input_tokens: 7, output_tokens: 3 } }),
    );
    const a = await anthropicModel(CONFIG, withUsage.fetchImpl).reply(request());
    expect(a.usage).toEqual({ input: 7, output: 3 });
    const without = fake(200, reply([{ type: "text", text: "a" }]));
    const b = await anthropicModel(CONFIG, without.fetchImpl).reply(request());
    expect(b).not.toHaveProperty("usage");
  });

  it("marks a reply cut off at max_tokens as truncated", async () => {
    const cut = fake(200, reply([{ type: "text", text: "a" }], { stop_reason: "max_tokens" }));
    const a = await anthropicModel(CONFIG, cut.fetchImpl).reply(request());
    expect(a.truncated).toBe(true);
    const whole = fake(200, reply([{ type: "text", text: "a" }], { stop_reason: "end_turn" }));
    const b = await anthropicModel(CONFIG, whole.fetchImpl).reply(request());
    expect(b).not.toHaveProperty("truncated");
  });

  describe("redirects", () => {
    const servers: Server[] = [];
    afterEach(async () => {
      await Promise.all(
        servers.splice(0).map((s) => new Promise<void>((done) => s.close(() => done()))),
      );
    });

    function listen(handler: Parameters<typeof createServer>[1]): Promise<string> {
      const server = createServer(handler);
      servers.push(server);
      return new Promise((resolve) =>
        server.listen(0, "127.0.0.1", () =>
          resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`),
        ),
      );
    }

    it("refuses a redirect and sends nothing on", async () => {
      let reached = 0;
      const target = await listen((_req, res) => {
        reached += 1;
        res.end("{}");
      });
      const redirector = await listen((_req, res) => {
        res.writeHead(307, { location: `${target}/stolen` });
        res.end();
      });
      const model = anthropicModel({ ...CONFIG, url: redirector }, fetch);
      await expect(model.reply(request())).rejects.toBeInstanceOf(AiUnavailable);
      expect(reached).toBe(0);
    });
  });

  describe("failures", () => {
    it("turns a refused key into AiUnavailable naming it", async () => {
      const error = await failure(fake(401, { error: KEY }).fetchImpl);
      expect(error.reason).toMatch(/refused the key/);
      expect(String(error)).not.toContain(KEY);
      expect(error.reason).not.toContain(KEY);
    });

    it("says it is busy on Anthropic's 529", async () => {
      const error = await failure(fake(529, `overloaded ${KEY}`).fetchImpl);
      expect(error.reason).toMatch(/busy/);
      expect(error.reason).not.toMatch(/529/);
      expect(String(error)).not.toContain(KEY);
    });

    it("turns a server error into AiUnavailable with its status", async () => {
      const error = await failure(fake(500, `boom ${KEY}`).fetchImpl);
      expect(error.reason).toMatch(/500/);
      expect(String(error)).not.toContain(KEY);
    });

    it("turns an unreachable host into AiUnavailable", async () => {
      const fetchImpl = (async () => {
        throw new TypeError(`fetch failed ${KEY}`);
      }) as unknown as Fetch;
      const error = await failure(fetchImpl);
      expect(error.reason).toMatch(/couldn't be reached/);
      expect(String(error)).not.toContain(KEY);
      expect(error.reason).not.toContain(KEY);
    });

    it("turns an abort into the timed-out reason", async () => {
      const controller = new AbortController();
      controller.abort();
      const fetchImpl = (async () => {
        throw new DOMException("aborted", "AbortError");
      }) as unknown as Fetch;
      const error = await failure(fetchImpl, request({ signal: controller.signal }));
      expect(error.reason).toMatch(/timed out/);
    });

    it("reads a time limit that hits while the body is being read as timed out", async () => {
      const controller = new AbortController();
      const fetchImpl = (async () =>
        new Response(
          new ReadableStream({
            pull(stream) {
              controller.abort();
              stream.error(new DOMException("aborted", "AbortError"));
            },
          }),
          { status: 200 },
        )) as unknown as Fetch;
      const error = await failure(fetchImpl, request({ signal: controller.signal }));
      expect(error.reason).toMatch(/timed out/);
    });

    it("turns a reply it can't read into AiUnavailable", async () => {
      for (const body of [
        `not json ${KEY}`,
        { nothing: true },
        { content: "text" },
        { content: [{ type: "tool_use", name: "find", input: {} }] },
      ]) {
        const error = await failure(fake(200, body).fetchImpl);
        expect(error.reason).toMatch(/couldn't be read/);
        expect(String(error)).not.toContain(KEY);
        expect(error.reason).not.toContain(KEY);
      }
    });
  });
});
