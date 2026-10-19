import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { AiUnavailable, type Fetch, type ModelRequest } from "./model.ts";
import { openAiModel } from "./openai.ts";

const KEY = "sk-secret-key-123";
const CONFIG = { url: "https://ai.example/v1", key: KEY, model: "m1", name: "Helper" };

type Seen = { url: string; init: RequestInit };

function fake(status: number, body: unknown): { fetchImpl: Fetch; seen: Seen[] } {
  const seen: Seen[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  }) as unknown as Fetch;
  return { fetchImpl, seen };
}

function reply(message: unknown, extra: Record<string, unknown> = {}) {
  return { choices: [{ message }], ...extra };
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
    await openAiModel(CONFIG, fetchImpl).reply(req);
  } catch (error) {
    expect(error).toBeInstanceOf(AiUnavailable);
    return error as AiUnavailable;
  }
  throw new Error("expected AiUnavailable");
}

describe("openAiModel", () => {
  it("posts to <url>/chat/completions with the model, system first, and tools as functions", async () => {
    const { fetchImpl, seen } = fake(200, reply({ content: "ok" }));
    const inputSchema = { type: "object", properties: { q: { type: "string" } } };
    await openAiModel(CONFIG, fetchImpl).reply(
      request({ tools: [{ name: "find", description: "Finds", inputSchema }] }),
    );
    expect(seen[0]?.url).toBe("https://ai.example/v1/chat/completions");
    expect(seen[0]?.init.method).toBe("POST");
    expect(sentHeaders(seen).authorization).toBe(`Bearer ${KEY}`);
    expect(seen[0]?.init.redirect).toBe("error");
    const body = sentBody(seen);
    expect(body.model).toBe("m1");
    expect(body.messages[0]).toEqual({ role: "system", content: "S" });
    expect(body.messages[1]).toEqual({ role: "user", content: "hi" });
    expect(body.tools[0]).toEqual({
      type: "function",
      function: { name: "find", description: "Finds", parameters: inputSchema },
    });
  });

  it("sends no authorization header without a key", async () => {
    const { fetchImpl, seen } = fake(200, reply({ content: "ok" }));
    await openAiModel({ ...CONFIG, key: undefined }, fetchImpl).reply(request());
    expect(sentHeaders(seen)).not.toHaveProperty("authorization");
  });

  it("sends earlier tool calls and their results in OpenAI's shape", async () => {
    const { fetchImpl, seen } = fake(200, reply({ content: "ok" }));
    await openAiModel(CONFIG, fetchImpl).reply(
      request({
        messages: [
          { role: "user", text: "find x" },
          {
            role: "assistant",
            text: "",
            toolCalls: [{ id: "c1", name: "find", arguments: { q: "x" } }],
          },
          { role: "tool", callId: "c1", name: "find", text: "result", isError: false },
        ],
      }),
    );
    const messages = sentBody(seen).messages;
    expect(messages[2].tool_calls).toEqual([
      { id: "c1", type: "function", function: { name: "find", arguments: '{"q":"x"}' } },
    ]);
    expect(messages[3]).toEqual({ role: "tool", tool_call_id: "c1", content: "result" });
  });

  it("reads text and tool calls, parsing JSON arguments", async () => {
    const { fetchImpl } = fake(
      200,
      reply({
        content: "looking",
        tool_calls: [
          { id: "c1", type: "function", function: { name: "find", arguments: '{"q":"x"}' } },
        ],
      }),
    );
    const out = await openAiModel(CONFIG, fetchImpl).reply(request());
    expect(out.text).toBe("looking");
    expect(out.toolCalls).toEqual([{ id: "c1", name: "find", arguments: { q: "x" } }]);
  });

  it("keeps a call whose arguments aren't JSON, marked badArguments", async () => {
    const { fetchImpl } = fake(
      200,
      reply({
        content: null,
        tool_calls: [
          { id: "c1", type: "function", function: { name: "find", arguments: "{oops" } },
        ],
      }),
    );
    const out = await openAiModel(CONFIG, fetchImpl).reply(request());
    expect(out.toolCalls).toEqual([
      { id: "c1", name: "find", arguments: undefined, badArguments: "{oops" },
    ]);
  });

  it("sends a bad-arguments call back with its raw string", async () => {
    const { fetchImpl, seen } = fake(200, reply({ content: "ok" }));
    await openAiModel(CONFIG, fetchImpl).reply(
      request({
        messages: [
          { role: "user", text: "go" },
          {
            role: "assistant",
            text: "",
            toolCalls: [{ id: "c1", name: "find", arguments: undefined, badArguments: "{oops" }],
          },
        ],
      }),
    );
    expect(sentBody(seen).messages[2].tool_calls[0].function.arguments).toBe("{oops");
  });

  it("reads token usage when the reply has it", async () => {
    const withUsage = fake(
      200,
      reply({ content: "a" }, { usage: { prompt_tokens: 7, completion_tokens: 3 } }),
    );
    const a = await openAiModel(CONFIG, withUsage.fetchImpl).reply(request());
    expect(a.usage).toEqual({ input: 7, output: 3 });
    const without = fake(200, reply({ content: "a" }));
    const b = await openAiModel(CONFIG, without.fetchImpl).reply(request());
    expect(b).not.toHaveProperty("usage");
  });

  it("treats null content as empty text", async () => {
    const { fetchImpl } = fake(200, reply({ content: null }));
    const out = await openAiModel(CONFIG, fetchImpl).reply(request());
    expect(out.text).toBe("");
    expect(out.toolCalls).toEqual([]);
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
      const model = openAiModel({ ...CONFIG, url: redirector }, fetch);
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
      expect(String(error)).not.toContain(KEY);
    });

    it("turns a reply it can't read into AiUnavailable", async () => {
      for (const body of [`not json ${KEY}`, { nothing: true }, { choices: [] }]) {
        const error = await failure(fake(200, body).fetchImpl);
        expect(error.reason).toMatch(/couldn't be read/);
        expect(String(error)).not.toContain(KEY);
        expect(error.reason).not.toContain(KEY);
      }
    });
  });
});
