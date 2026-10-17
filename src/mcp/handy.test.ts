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

/** A link's tool row as the tests compare it (instants in ms), undefined when it has none. */
function row(id: string) {
  const r = db
    .prepare(
      "SELECT status, source, since, answered_at AS answeredAt, wait_days AS waitDays FROM link_tools WHERE link_id = ?",
    )
    .get(Number(id));
  return r as
    | { status: string; source: string; since: number; answeredAt: number | null; waitDays: number }
    | undefined;
}

const linkCount = () => (db.prepare("SELECT COUNT(*) AS n FROM links").get() as { n: number }).n;
const summaryOf = (id: string) =>
  (
    db.prepare("SELECT summary FROM links WHERE id = ?").get(Number(id)) as {
      summary: string | null;
    }
  ).summary;
const ONLY_OWNER = /Only the owner can say this/;
const NOT_KEPT = /not kept handy/;

describe("update_link's handy, every action and source", () => {
  it.each([
    ["keep", "stated", false, { status: "kept", source: "stated", answered: false }],
    ["keep", "asked", false, { status: "kept", source: "asked", answered: false }],
    ["keep", "inferred", false, { status: "suggested", source: "inferred", answered: false }],
    ["still_using", "stated", true, { status: "kept", source: "stated", answered: true }],
    ["still_using", "asked", true, { status: "kept", source: "stated", answered: true }],
    ["not_handy", "stated", false, { status: "declined", source: "stated", answered: false }],
    ["not_handy", "asked", false, { status: "declined", source: "asked", answered: false }],
  ] as const)(
    "%s with %s (kept first: %s) writes the row and returns its view",
    async (action, source, keptFirst, want) => {
      await call("save_link", { url: "https://example.com/t" });
      if (keptFirst) await keptDaysAgo("1", 10);

      const res = await call("update_link", {
        id: "1",
        summary: "changed",
        handy: { action, source },
      });

      expect(res.isError).toBe(false);
      expect(row("1")).toMatchObject({
        status: want.status,
        source: want.source,
        answeredAt: want.answered ? NOW.getTime() : null,
      });
      expect(res.data.link.handy).toEqual({ status: want.status, source: want.source, due: false });
      expect(res.data.link.summary).toBe("changed");
    },
  );

  it.each([
    ["still_using", "inferred", true, ONLY_OWNER],
    ["not_handy", "inferred", false, ONLY_OWNER],
    ["still_using", "stated", false, NOT_KEPT],
  ] as const)(
    "%s with %s (kept first: %s) is refused and writes nothing, not even the other fields",
    async (action, source, keptFirst, message) => {
      await call("save_link", { url: "https://example.com/t" });
      if (keptFirst) await keptDaysAgo("1", 10);
      const before = row("1");

      const res = await call("update_link", {
        id: "1",
        summary: "changed",
        handy: { action, source },
      });

      expect(res.isError).toBe(true);
      expect(res.text).toMatch(message);
      expect(row("1")).toEqual(before);
      expect(summaryOf("1")).toBeNull();
    },
  );

  it("a blank tag name refuses the whole call before handy writes anything", async () => {
    await call("save_link", { url: "https://example.com/t" });

    const res = await call("update_link", {
      id: "1",
      tags: [{ name: "   ", source: "stated" }],
      handy: { action: "keep", source: "stated" },
    });

    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/tag name is empty/);
    expect(row("1")).toBeUndefined();
  });

  it("a 201-character title refuses the whole call before handy writes anything", async () => {
    await call("save_link", { url: "https://example.com/t", title: "Before" });

    const res = await call("update_link", {
      id: "1",
      title: "a".repeat(201),
      handy: { action: "keep", source: "stated" },
    });

    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/at most 200 characters/);
    expect(row("1")).toBeUndefined();
    expect(db.prepare("SELECT title FROM links WHERE id = 1").get()).toEqual({ title: "Before" });
  });

  it("an inferred keep leaves a link the owner declined or kept as it is", async () => {
    await call("save_link", { url: "https://example.com/declined" });
    await call("save_link", { url: "https://example.com/kept" });
    await call("update_link", { id: "1", handy: { action: "not_handy", source: "asked" } });
    await keptDaysAgo("2", 0);
    const before = [row("1"), row("2")];

    for (const id of ["1", "2"]) {
      const res = await call("update_link", { id, handy: { action: "keep", source: "inferred" } });
      expect(res.isError).toBe(false);
    }

    expect([row("1"), row("2")]).toEqual(before);
  });
});

describe("one instant per request, under a clock that advances 1 ms per read", () => {
  const dueAt = async (ms: number) => {
    clock = new Date(ms);
    return (await call("get_link", { id: "1" })).data.link.handy.due as boolean;
  };
  const yes = async (ms: number) => {
    clock = new Date(ms);
    const res = await call("update_link", {
      id: "1",
      handy: { action: "still_using", source: "stated" },
    });
    expect(res.isError).toBe(false);
  };

  it("an opening and a Still using answer in one call share one instant: due 30 days on, and the next Yes keeps the wait at 30", async () => {
    await call("save_link", { url: "https://example.com/t" });
    await keptDaysAgo("1", 40);
    advancing = true;

    const res = await call("update_link", {
      id: "1",
      opened: true,
      handy: { action: "still_using", source: "stated" },
    });
    advancing = false;

    const t = Date.parse(res.data.link.lastOpenedAt);
    expect(row("1")).toMatchObject({ answeredAt: t, waitDays: 60 });
    expect(await dueAt(t + 30 * DAY - 1)).toBe(false);
    expect(await dueAt(t + 30 * DAY)).toBe(true);
    await yes(t + 30 * DAY);
    // The opening counts as since the last check (same instant), so the wait goes back to 30, not up to 120.
    expect(row("1")).toMatchObject({ answeredAt: t + 30 * DAY, waitDays: 30 });
    expect(await dueAt(t + 60 * DAY - 1)).toBe(false);
    expect(await dueAt(t + 60 * DAY)).toBe(true);
  });

  it("an opening and a keep in one call share one instant: due 30 days on, and the first Yes keeps the wait at 30", async () => {
    await call("save_link", { url: "https://example.com/t" });
    advancing = true;

    const res = await call("update_link", {
      id: "1",
      opened: true,
      handy: { action: "keep", source: "stated" },
    });
    advancing = false;

    const t = Date.parse(res.data.link.lastOpenedAt);
    expect(row("1")).toMatchObject({ status: "kept", since: t, waitDays: 30 });
    expect(await dueAt(t + 30 * DAY - 1)).toBe(false);
    expect(await dueAt(t + 30 * DAY)).toBe(true);
    await yes(t + 30 * DAY);
    expect(row("1")).toMatchObject({ answeredAt: t + 30 * DAY, waitDays: 30 });
  });

  it("a save_link with keep keeps the link at the instant it was saved", async () => {
    advancing = true;
    const res = await call("save_link", {
      url: "https://example.com/t",
      handy: { action: "keep", source: "stated" },
    });
    advancing = false;
    expect(row("1")).toMatchObject({ status: "kept", since: Date.parse(res.data.link.savedAt) });
  });
});

describe("save_link's handy", () => {
  it.each([
    ["keep", "stated", { status: "kept", source: "stated" }],
    ["keep", "asked", { status: "kept", source: "asked" }],
    ["keep", "inferred", { status: "suggested", source: "inferred" }],
    ["not_handy", "stated", { status: "declined", source: "stated" }],
    ["not_handy", "asked", { status: "declined", source: "asked" }],
  ] as const)(
    "%s with %s on a new link writes the row and returns its view",
    async (action, source, want) => {
      const res = await call("save_link", {
        url: "https://example.com/t",
        handy: { action, source },
      });
      expect(res.isError).toBe(false);
      expect(res.data.created).toBe(true);
      expect(row("1")).toMatchObject({
        ...want,
        since: NOW.getTime(),
        answeredAt: null,
        waitDays: 30,
      });
      expect(res.data.link.handy).toEqual({ ...want, due: false });
    },
  );

  it.each([
    ["still_using", "stated", NOT_KEPT],
    ["still_using", "asked", NOT_KEPT],
    ["still_using", "inferred", ONLY_OWNER],
    ["not_handy", "inferred", ONLY_OWNER],
  ] as const)(
    "%s with %s on a new link keeps the link, writes no row, and says the link was saved",
    async (action, source, message) => {
      const res = await call("save_link", {
        url: "https://example.com/t",
        handy: { action, source },
      });
      expect(res.isError).toBe(true);
      expect(res.text).toContain('The link was saved with id "1"');
      expect(res.text).toMatch(message);
      expect(res.text).toContain("update_link");
      expect(linkCount()).toBe(1);
      expect(row("1")).toBeUndefined();
    },
  );

  it("a repeat save ignores handy, writing nothing, and reports the link's current view", async () => {
    await call("save_link", { url: "https://example.com/t" });
    const repeat = await call("save_link", {
      url: "https://example.com/t",
      handy: { action: "keep", source: "stated" },
    });
    expect(repeat.data.created).toBe(false);
    expect(row("1")).toBeUndefined();
    expect(repeat.data.link.handy).toBeNull();

    await keepHandy(deps, A.owner, "1", "asked");
    const again = await call("save_link", {
      url: "https://example.com/t",
      handy: { action: "not_handy", source: "stated" },
    });
    expect(row("1")).toMatchObject({ status: "kept", source: "asked" });
    expect(again.data.link.handy).toEqual({ status: "kept", source: "asked", due: false });
  });

  it("advertises handy on both tools and refuses an unknown action before anything is written", async () => {
    const res = await app.fetch(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          host: "localhost",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/list" }),
      }),
    );
    const line = (await res.text()).split("\n").find((l) => l.startsWith("data:")) as string;
    const tools: Json[] = JSON.parse(line.slice(5)).result.tools;
    for (const name of ["save_link", "update_link"]) {
      const handy = tools.find((t) => t.name === name).inputSchema.properties.handy;
      expect(handy.properties.action.enum, name).toEqual(["keep", "still_using", "not_handy"]);
      expect(handy.properties.source.enum, name).toEqual(["stated", "asked", "inferred"]);
      expect(handy.description, name).toContain("inferred");
    }

    const bad = await call("save_link", {
      url: "https://example.com/t",
      handy: { action: "pin", source: "stated" },
    });
    expect(bad.isError).toBe(true);
    expect(linkCount()).toBe(0);
  });
});
