import { describe, expect, it } from "vitest";
import { createChatModel } from "./create-model.ts";
import type { Fetch, ModelRequest } from "./model.ts";

const request: ModelRequest = {
  system: "S",
  messages: [{ role: "user", text: "hi" }],
  tools: [],
  signal: new AbortController().signal,
};

async function urlPosted(api: "openai" | "anthropic") {
  const urls: string[] = [];
  const fetchImpl = (async (url: string) => {
    urls.push(url);
    const body = api === "openai" ? { choices: [{ message: { content: "ok" } }] } : { content: [] };
    return new Response(JSON.stringify(body));
  }) as unknown as Fetch;
  const model = createChatModel(
    { api, url: "https://ai.example", key: "k", model: "m", name: "Helper" },
    fetchImpl,
  );
  await model.reply(request);
  return { model, url: urls[0] };
}

describe("createChatModel", () => {
  it("builds the connector its API names, with its name", async () => {
    const anthropic = await urlPosted("anthropic");
    expect(anthropic.url).toBe("https://ai.example/v1/messages");
    expect(anthropic.model.name).toBe("Helper");
    const openai = await urlPosted("openai");
    expect(openai.url).toBe("https://ai.example/chat/completions");
    expect(openai.model.name).toBe("Helper");
  });
});
