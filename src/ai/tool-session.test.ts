import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import type { Caller } from "../auth/caller.js";
import { createDeps } from "../deps.js";
import { createCallTracker } from "../mcp/call-tracker.js";
import * as guidance from "../mcp/guidance.js";
import type { McpDeps } from "../mcp/server.js";
import { FakeEmbedder } from "../search/embedder.js";
import { DIMS } from "../search/model.js";
import { openDatabase } from "../store/database.js";
import { openToolSession, type ToolSession } from "./tool-session.js";

const NOW = new Date("2026-10-19T12:00:00.000Z");
const CALLER: Caller = { owner: "owner-a", savedBy: "In-app AI (Fake)" };

const setups: { db: ReturnType<typeof openDatabase>; session?: ToolSession }[] = [];

function setup(extra: Pick<McpDeps, "snapshots" | "saveWaitMs"> = {}) {
  const db = openDatabase(":memory:");
  const deps = { ...createDeps(db, new FakeEmbedder(DIMS)), now: () => NOW, ...extra };
  deps.store.ensureUser(CALLER.owner, CALLER.owner);
  const entry: (typeof setups)[number] = { db };
  setups.push(entry);
  return { db, deps, entry };
}

afterEach(async () => {
  for (const { db, session } of setups.splice(0)) {
    await session?.close();
    db.close();
  }
});

/** Asks the MCP door over HTTP, the way readme.test.ts does. */
async function door(deps: ReturnType<typeof createDeps>, method: string, params?: unknown) {
  const { app } = createApp({
    deps,
    identify: async () => ({ ...CALLER, rateKey: "owner" }),
  });
  const res = await app.fetch(
    new Request("http://localhost/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        host: "localhost",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }),
  );
  const text = await res.text();
  const data = text.split("\n").find((l) => l.startsWith("data:"));
  return JSON.parse(data ? data.slice(5) : text).result;
}

describe("openToolSession", () => {
  it("sees the same tools and instructions as the MCP door", async () => {
    const { deps, entry } = setup();
    const listed = await door(deps, "tools/list");
    const init = await door(deps, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "0" },
    });
    entry.session = await openToolSession(deps, CALLER, createCallTracker().track);

    expect(entry.session.tools.length).toBeGreaterThan(0);
    expect(entry.session.tools).toEqual(
      listed.tools.map((t: { name: string; description: string; inputSchema: unknown }) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      })),
    );
    expect(entry.session.instructions).toBe(init.instructions);
    expect(entry.session.instructions).toBe(guidance.INSTRUCTIONS);
  });

  it("saves as the caller it was opened for", async () => {
    const { db, deps, entry } = setup();
    entry.session = await openToolSession(deps, CALLER, createCallTracker().track);

    const result = await entry.session.call("save_link", { url: "https://example.com/a" });

    expect(result.isError).toBe(false);
    expect(db.prepare("SELECT owner_id, saved_by FROM links").all()).toEqual([
      { owner_id: "owner-a", saved_by: "In-app AI (Fake)" },
    ]);
  });

  it("passes a tool's refusal back as an error result", async () => {
    const { deps, entry } = setup();
    entry.session = await openToolSession(deps, CALLER, createCallTracker().track);

    const result = await entry.session.call("get_link", { id: "9999" });

    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/No link with id/);
  });

  it("counts its calls on the shared tracker", async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { deps, entry } = setup({
      snapshots: { kick: () => held },
      saveWaitMs: 60_000,
    });
    const tracker = createCallTracker();
    entry.session = await openToolSession(deps, CALLER, tracker.track);

    const saving = entry.session.call("save_link", { url: "https://example.com/b" });
    await expect.poll(() => tracker.calls().running).toBe(1);
    release();
    await saving;
    await tracker.calls().ended;

    expect(tracker.calls().running).toBe(0);
  });

  it("lists its changes in commit order, as a copy", async () => {
    const { deps, entry } = setup();
    entry.session = await openToolSession(deps, CALLER, createCallTracker().track);

    await entry.session.call("save_link", {
      url: "https://example.com/a",
      tags: [{ name: "kitchen", source: "stated" }],
    });
    await entry.session.call("update_tag", { name: "kitchen", kind: "project" });
    const listed = entry.session.changes();
    listed.pop();

    expect(entry.session.changes()).toEqual([
      { kind: "link", tool: "save_link", linkId: "1", created: true, fields: [] },
      { kind: "tag", name: "kitchen", tagKind: "project" },
    ]);
  });

  it("rejects a call still waiting when the session closes", async () => {
    const { deps, entry } = setup({
      snapshots: { kick: () => new Promise<void>(() => {}) },
      saveWaitMs: 60_000,
    });
    const tracker = createCallTracker();
    const session = await openToolSession(deps, CALLER, tracker.track);
    entry.session = session;

    const saving = session.call("save_link", { url: "https://example.com/c" });
    const outcome = expect(saving).rejects.toThrow(/closed/);
    await expect.poll(() => tracker.calls().running).toBe(1);
    await session.close();

    await outcome;
    await expect(session.call("get_link", { id: "1" })).rejects.toThrow(/closed/);
  });
});
