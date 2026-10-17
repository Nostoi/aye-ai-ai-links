import type { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import type { Caller } from "../auth/caller.js";
import { keepHandy } from "../core/tools.js";
import { createDeps } from "../deps.js";
import { FakeEmbedder } from "../search/embedder.js";
import { DIMS } from "../search/model.js";
import { openDatabase } from "../store/database.js";

const A: Caller = { owner: "owner-a", savedBy: "claude-code" };
const DAY = 86_400_000;
const NOW = new Date("2026-10-16T12:00:00.000Z");
const at = (delta: number) => new Date(NOW.getTime() + delta);

// biome-ignore lint/suspicious/noExplicitAny: the tests read untyped JSON-RPC bodies
type Json = any;

let clock: Date;
/** When set, every clock read is 1 ms after the last, as the wall clock can be within one request. */
let advancing: boolean;
let db: ReturnType<typeof openDatabase>;
let deps: ReturnType<typeof createDeps>;
let app: Hono;

function readClock(): Date {
  if (advancing) clock = new Date(clock.getTime() + 1);
  return clock;
}

beforeEach(() => {
  clock = NOW;
  advancing = false;
  db = openDatabase(":memory:");
  deps = { ...createDeps(db, new FakeEmbedder(DIMS)), now: readClock };
  deps.store.ensureUser(A.owner, A.owner);
  app = createApp({ deps, identify: async () => ({ ...A, rateKey: "a" }) }).app;
});

let rpcId = 0;
/** One tools/call; a JSON-RPC error (a schema refusal) counts as an error too. */
async function call(
  name: string,
  args: unknown,
): Promise<{ isError: boolean; data: Json; text: string }> {
  const res = await app.fetch(
    new Request("http://localhost/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        host: "localhost",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: ++rpcId,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    }),
  );
  const text = await res.text();
  const line = text.split("\n").find((l) => l.startsWith("data:"));
  const body = JSON.parse(line ? line.slice(5) : text) as Json;
  return {
    isError: body.error !== undefined || body.result?.isError === true,
    data: body.result?.structuredContent,
    text: String(body.result?.content?.[0]?.text ?? body.error?.message ?? ""),
  };
}

/** Keeps link `id` handy as stated, `daysAgo` days before now. */
async function keptDaysAgo(id: string, daysAgo: number): Promise<void> {
  clock = at(-daysAgo * DAY);
  await keepHandy(deps, A.owner, id, "stated");
  clock = NOW;
}

describe("the handy view on link results", () => {
  it("every tool that returns links gives each its handy view, null for an ordinary link", async () => {
    await call("save_link", { url: "https://example.com/tool" });
    await call("save_link", { url: "https://example.com/read" });
    await keptDaysAgo("1", 0);
    const view = { status: "kept", source: "stated", due: false };
    const byId = (links: Json[]) => Object.fromEntries(links.map((l) => [l.id, l.handy]));

    expect((await call("get_link", { id: "1" })).data.link.handy).toEqual(view);
    expect((await call("get_link", { id: "2" })).data.link.handy).toBeNull();
    expect((await call("update_link", { id: "1", summary: "s" })).data.link.handy).toEqual(view);
    expect((await call("save_link", { url: "https://example.com/tool" })).data.link.handy).toEqual(
      view,
    );
    expect(byId((await call("search_links", { query: "" })).data.links)).toEqual({
      1: view,
      2: null,
    });
    expect(byId((await call("list_links", {})).data.links)).toEqual({ 1: view, 2: null });
  });

  it("get_digest returns a due tool as a still_using_check item with its handy view, and marks it shown", async () => {
    await call("save_link", { url: "https://example.com/tool" });
    await keptDaysAgo("1", 40);

    const res = await call("get_digest", {});

    expect(res.isError).toBe(false);
    expect(res.data.links.map((d: Json) => [d.link.id, d.reasons, d.link.handy])).toEqual([
      [
        "1",
        [{ kind: "still_using_check", daysSinceOpened: null }],
        { status: "kept", source: "stated", due: true },
      ],
    ]);
    expect(db.prepare("SELECT last_surfaced_at AS at FROM links WHERE id = 1").get()).toEqual({
      at: NOW.getTime(),
    });
  });
});
