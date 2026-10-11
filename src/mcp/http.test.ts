import type { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import type { Caller, Identify } from "../auth/caller.js";
import { filingContext } from "../core/filing-context.js";
import { getLink, saveLink, updateLink } from "../core/links.js";
import { addProfile, editProfile, getProfile, profileContext } from "../core/profile.js";
import { searchLinks } from "../core/search-links.js";
import { createDeps } from "../deps.js";
import { openDatabase } from "../store/database.js";

const appFor = (options: Parameters<typeof createApp>[0]) => createApp(options).app;

const NOW = new Date("2026-10-11T12:00:00.000Z");
const A: Caller = { owner: "owner-a", savedBy: "claude-code" };
const B: Caller = { owner: "owner-b", savedBy: "codex" };
const KEYS: Record<string, Caller> = { "key-a": A, "key-b": B };
const identify: Identify = async (request) => {
  const key = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  return KEYS[key] ?? null;
};

function freshDeps() {
  const db = openDatabase(":memory:");
  const deps = { ...createDeps(db), now: () => NOW };
  for (const o of [A.owner, B.owner]) deps.store.ensureUser(o, o);
  return { db, deps };
}

// biome-ignore lint/suspicious/noExplicitAny: the tests read untyped JSON-RPC bodies
type Json = any;
type Rpc = { status: number; headers: Headers; body: Json };

async function post(app: Hono, key: string | null, body: unknown, extra: HeadersInit = {}) {
  const headers = new Headers({
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    host: "localhost",
  });
  if (key) headers.set("authorization", `Bearer ${key}`);
  new Headers(extra).forEach((v, k) => {
    headers.set(k, v);
  });
  const res = await app.fetch(
    new Request("http://localhost/mcp", { method: "POST", headers, body: JSON.stringify(body) }),
  );
  const text = await res.text();
  const data = text.split("\n").find((l) => l.startsWith("data:"));
  const json = res.headers.get("content-type")?.includes("event-stream")
    ? JSON.parse((data ?? "data: null").slice(5))
    : text
      ? safeJson(text)
      : null;
  return { status: res.status, headers: res.headers, body: json } as Rpc;
}

const safeJson = (t: string) => {
  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
};

let id = 0;
const call = (app: Hono, key: string | null, name: string, args: unknown) =>
  post(app, key, {
    jsonrpc: "2.0",
    id: ++id,
    method: "tools/call",
    params: { name, arguments: args },
  });

/** Parse the JSON round trip core results would take through the door. */
const wire = (v: unknown) => JSON.parse(JSON.stringify(v));

const linkCount = (db: ReturnType<typeof openDatabase>) =>
  (db.prepare("SELECT COUNT(*) AS n FROM links").get() as { n: number }).n;

describe("MCP door over HTTP", () => {
  let app: Hono;
  let deps: ReturnType<typeof freshDeps>["deps"];
  let db: ReturnType<typeof openDatabase>;
  // a parallel database, driven only through core, for door-versus-core parity
  let direct: ReturnType<typeof freshDeps>["deps"];

  beforeEach(() => {
    ({ db, deps } = freshDeps());
    ({ deps: direct } = freshDeps());
    app = appFor({ deps, identify });
  });

  it("answers a 2025-style initialize with the agent instructions", async () => {
    const res = await post(app, "key-a", {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "0" },
      },
    });
    expect(res.status).toBe(200);
    expect(res.body.result.instructions).toContain("stated");
    expect(res.body.result.instructions).toContain("asked");
    expect(res.body.result.instructions).toContain("inferred");
  });

  it("keeps instructions and descriptions within client limits, key rules first", async () => {
    const list = await post(app, "key-a", { jsonrpc: "2.0", id: 2, method: "tools/list" });
    const init = await post(app, "key-a", {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "t", version: "0" },
      },
    });
    const texts: string[] = [
      init.body.result.instructions,
      ...list.body.result.tools.map((t: Json) => t.description),
    ];
    for (const t of texts) expect(t.length).toBeLessThanOrEqual(2048);
    const head: string = init.body.result.instructions.slice(0, 512);
    expect(head).toContain("inferred");
    expect(head).toMatch(/reuse/i);
  });

  it("includes instructions in the modern server/discover result", async () => {
    const res = await post(
      app,
      "key-a",
      {
        jsonrpc: "2.0",
        id: 3,
        method: "server/discover",
        params: {
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      },
      { "mcp-protocol-version": "2026-07-28", "mcp-method": "server/discover" },
    );
    expect(res.status).toBe(200);
    expect(res.body.result.instructions).toContain("inferred");
  });

  it("lists the seven tools with their annotations and string dates", async () => {
    const res = await post(app, "key-a", { jsonrpc: "2.0", id: 2, method: "tools/list" });
    const tools = Object.fromEntries(res.body.result.tools.map((t: Json) => [t.name, t]));
    expect(Object.keys(tools).sort()).toEqual([
      "add_profile",
      "edit_profile",
      "get_link",
      "get_profile",
      "save_link",
      "search_links",
      "update_link",
    ]);
    const hints = (readOnlyHint: boolean, destructiveHint: boolean, idempotentHint: boolean) => ({
      readOnlyHint,
      destructiveHint,
      idempotentHint,
      openWorldHint: false,
    });
    expect(tools.search_links.annotations).toEqual(hints(true, false, true));
    expect(tools.get_link.annotations).toEqual(hints(true, false, true));
    expect(tools.save_link.annotations).toEqual(hints(false, false, true));
    expect(tools.update_link.annotations).toEqual(hints(false, true, false));
    expect(tools.get_profile.annotations).toEqual(hints(true, false, true));
    expect(tools.add_profile.annotations).toEqual(hints(false, false, false));
    expect(tools.edit_profile.annotations).toEqual(hints(false, true, false));
    expect(tools.get_profile.inputSchema.additionalProperties).toBe(false);
    expect(tools.search_links.inputSchema.properties.savedFrom.type).toBe("string");
    expect(JSON.stringify(tools.update_link.inputSchema.properties.snoozedUntil)).toContain(
      '"string"',
    );
    for (const t of Object.values<Json>(tools)) expect(t.description.length).toBeGreaterThan(40);
  });

  it("save_link returns the link, created and the filing context, as a hand-written payload", async () => {
    const res = await call(app, "key-a", "save_link", {
      url: "https://example.com/a",
      title: "Example",
      summary: "A page",
      why: { text: "for the launch", source: "stated" },
      tags: [
        { name: "Reading", source: "asked" },
        { name: "Aye Launch", source: "inferred", kind: "project" },
      ],
    });
    expect(res.body.result.isError).toBeUndefined();
    const reading = {
      key: "reading",
      name: "Reading",
      kind: "topic",
      color: null,
      pinned: false,
      description: null,
      projectStatus: null,
    };
    const launch = { ...reading, key: "aye launch", name: "Aye Launch", kind: "project" };
    const expected = {
      link: {
        id: "1",
        url: "https://example.com/a",
        urlKey: expect.any(String),
        title: "Example",
        summary: "A page",
        why: { text: "for the launch", source: "stated" },
        tags: [
          { key: "reading", name: "Reading", source: "asked", kind: "topic" },
          { key: "aye launch", name: "Aye Launch", source: "inferred", kind: "project" },
        ],
        savedAt: "2026-10-11T12:00:00.000Z",
        savedBy: "claude-code",
        lastOpenedAt: null,
        lastSurfacedAt: null,
        snoozedUntil: null,
        state: "active",
      },
      created: true,
      filingContext: { tags: [launch, reading], activeProjects: [launch] },
      profile: { notes: [], recentFocus: [] },
    };
    expect(res.body.result.structuredContent).toEqual(expected);
    expect(JSON.parse(res.body.result.content[0].text)).toEqual(res.body.result.structuredContent);
  });

  it("every tool equals the direct core call with the same clock", async () => {
    const input = {
      url: "https://example.com/p",
      title: "Parity",
      why: { text: "w", source: "stated" as const },
      tags: [{ name: "Alpha", source: "stated" as const, kind: "project" as const }],
    };
    const viaDoor = await call(app, "key-a", "save_link", input);
    const saved = await saveLink(direct, A.owner, { ...input, savedBy: A.savedBy });
    expect(viaDoor.body.result.structuredContent).toEqual(
      wire({
        ...saved,
        filingContext: await filingContext(direct, A.owner),
        profile: await profileContext(direct, A.owner),
      }),
    );

    const patch = {
      summary: "s",
      tags: [{ name: "Beta", source: "asked" as const }],
      opened: true as const,
    };
    const upd = await call(app, "key-a", "update_link", { id: "1", ...patch });
    const updDirect = await updateLink(direct, A.owner, "1", patch);
    expect(upd.body.result.structuredContent).toEqual(wire({ link: updDirect }));

    const got = await call(app, "key-a", "get_link", { id: "1" });
    expect(got.body.result.structuredContent).toEqual(
      wire({ link: await getLink(direct, A.owner, "1") }),
    );

    const found = await call(app, "key-a", "search_links", {
      query: "parity",
      savedFrom: "2026-10-11T00:00:00+00:00",
    });
    const foundDirect = await searchLinks(direct, A.owner, {
      query: "parity",
      savedFrom: new Date("2026-10-11T00:00:00Z"),
    });
    expect(foundDirect).toHaveLength(1);
    expect(found.body.result.structuredContent).toEqual(wire({ links: foundDirect }));
  });

  it("ignores owner and savedBy arguments", async () => {
    const res = await call(app, "key-a", "save_link", {
      url: "https://example.com/spoof",
      owner: B.owner,
      savedBy: "evil",
    });
    expect(res.body.result.structuredContent.link.savedBy).toBe("claude-code");
    const bSearch = await call(app, "key-b", "search_links", { query: "" });
    expect(bSearch.body.result.structuredContent.links).toEqual([]);
    const aSearch = await call(app, "key-a", "search_links", { query: "", owner: B.owner });
    expect(aSearch.body.result.structuredContent.links).toHaveLength(1);
  });

  it("keeps owners apart", async () => {
    await call(app, "key-b", "save_link", {
      url: "https://example.com/b-only",
      title: "secretword",
    });
    const get = await call(app, "key-a", "get_link", { id: "1" });
    expect(get.body.result.isError).toBe(true);
    expect(get.body.result.content[0].text).toContain("No link with id");
    const upd = await call(app, "key-a", "update_link", { id: "1", summary: "hijack" });
    expect(upd.body.result.isError).toBe(true);
    const search = await call(app, "key-a", "search_links", { query: "secretword" });
    expect(search.body.result.structuredContent.links).toEqual([]);
    const still = await call(app, "key-b", "get_link", { id: "1" });
    expect(still.body.result.structuredContent.link.summary).toBeNull();
  });

  it.each([
    ["no key", null],
    ["wrong key", "nope"],
  ])("refuses %s with 401 and writes nothing", async (_n, key) => {
    const res = await call(app, key, "save_link", { url: "https://example.com/x" });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toMatch(/^Bearer/);
    expect(linkCount(db)).toBe(0);
    const list = await post(app, key, { jsonrpc: "2.0", id: 9, method: "tools/list" });
    expect(list.status).toBe(401);
  });

  it("returns core's message for an unknown id", async () => {
    const res = await call(app, "key-a", "get_link", { id: "999" });
    expect(res.body.result.isError).toBe(true);
    expect(res.body.result.content[0].text).toBe(
      'No link with id "999" was found. Use search_links to find the right id.',
    );
  });

  it("tells an operator when the owner record is missing", async () => {
    const ghost = appFor({ deps, identify: async () => ({ owner: "ghost", savedBy: "x" }) });
    const res = await call(ghost, "any", "save_link", { url: "https://example.com/g" });
    expect(res.body.result.isError).toBe(true);
    expect(res.body.result.content[0].text).toContain("owner record");
    expect(res.body.result.content[0].text).not.toContain("ghost");
  });

  it("refuses bad enums and timestamps before anything is written", async () => {
    const badSource = await call(app, "key-a", "save_link", {
      url: "https://example.com/e",
      why: { text: "w", source: "guessed" },
    });
    const dateOnly = await call(app, "key-a", "search_links", {
      query: "",
      savedFrom: "2026-10-01",
    });
    const subMs = await call(app, "key-a", "search_links", {
      query: "",
      savedTo: "2026-10-01T00:00:00.0009Z",
    });
    const noZone = await call(app, "key-a", "search_links", {
      query: "",
      savedTo: "2026-10-01T00:00:00",
    });
    const badSnooze = await call(app, "key-a", "update_link", {
      id: "1",
      snoozedUntil: "2026-10-01",
    });
    const badTag = await call(app, "key-a", "save_link", {
      url: "https://example.com/e2",
      tags: [{ name: "t", source: "stated", kind: "folder" }],
    });
    const refusals = [badSource, dateOnly, subMs, noZone, badSnooze, badTag].map((r) => ({
      error: r.body.error?.message ?? r.body.result?.content?.[0]?.text,
      isError: r.body.result?.isError ?? Boolean(r.body.error),
    }));
    for (const r of refusals) expect(r.isError).toBe(true);
    expect(refusals[0]?.error).toContain("source");
    for (const r of refusals.slice(1, 5)) expect(r.error).toMatch(/ISO-8601|snoozedUntil|saved/);
    expect(linkCount(db)).toBe(0);
  });

  it.each(["2026-02-30T00:00:00Z", "2026-04-31T10:00:00+02:00", "2025-02-29T00:00:00Z"])(
    "refuses the impossible date %s",
    async (savedFrom) => {
      const res = await call(app, "key-a", "search_links", { query: "", savedFrom });
      expect(res.body.result.isError).toBe(true);
      expect(res.body.result.content[0].text).toContain("ISO-8601");
    },
  );

  it.each(["2024-02-29T00:00:00Z", "0001-01-01T00:00:00Z", "0099-12-31T23:59:59Z"])(
    "accepts the real date %s",
    async (savedFrom) => {
      const res = await call(app, "key-a", "search_links", { query: "", savedFrom });
      expect(res.body.result.isError).toBeUndefined();
    },
  );

  it("logs an unexpected error but shows the agent nothing internal", async () => {
    const boom = new Error("secret-internal-detail");
    const broken = appFor({
      deps: {
        ...deps,
        search: {
          search: async () => {
            throw boom;
          },
        },
      },
      identify,
    });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await call(broken, "key-a", "search_links", { query: "x" });
      expect(res.body.result.isError).toBe(true);
      expect(JSON.stringify(res.body)).not.toContain("secret-internal-detail");
      expect(spy).toHaveBeenCalledWith(expect.any(String), boom);
      const known = await call(broken, "key-a", "get_link", { id: "999" });
      expect(known.body.result.isError).toBe(true);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("accepts a timestamp with fractions and an offset", async () => {
    await call(app, "key-a", "save_link", { url: "https://example.com/t" });
    const res = await call(app, "key-a", "search_links", {
      query: "",
      savedFrom: "2026-10-11T14:00:00.000+02:00",
      savedTo: "2026-10-11T12:00:00.000Z",
    });
    expect(res.body.result.structuredContent.links).toHaveLength(1);
  });

  it("keeps core's limit handling", async () => {
    await call(app, "key-a", "save_link", { url: "https://example.com/l" });
    const big = await call(app, "key-a", "search_links", { query: "", limit: 500 });
    expect(big.body.result.structuredContent.links).toHaveLength(1);
    const frac = await call(app, "key-a", "search_links", { query: "", limit: 1.5 });
    expect(frac.body.result.isError).toBe(true);
    expect(frac.body.result.content[0].text).toContain("limit must be a whole number");
  });

  it("update_link replaces the tag set and clears with null", async () => {
    await call(app, "key-a", "save_link", {
      url: "https://example.com/u",
      summary: "keep?",
      why: { text: "w", source: "stated" },
      tags: [
        { name: "one", source: "stated" },
        { name: "two", source: "stated" },
      ],
    });
    const res = await call(app, "key-a", "update_link", {
      id: "1",
      tags: [{ name: "three", source: "asked" }],
      summary: null,
    });
    const link = res.body.result.structuredContent.link;
    expect(link.tags.map((t: Json) => t.key)).toEqual(["three"]);
    expect(link.summary).toBeNull();
    expect(link.why).toEqual({ text: "w", source: "stated" });
  });

  it("refuses to serve a request whose caller has no owner", async () => {
    const blank = appFor({ deps, identify: async () => ({ owner: "", savedBy: "x" }) });
    const res = await call(blank, "any", "save_link", { url: "https://example.com/blank" });
    expect(JSON.stringify(res.body)).not.toContain("owner record");
    expect(res.body.result?.structuredContent).toBeUndefined();
    expect(linkCount(db)).toBe(0);
  });

  it.each([
    ["default options", undefined, "localhost"],
    ["allowedHosts set", ["mac.tailnet.ts.net"], "mac.tailnet.ts.net"],
  ])(
    "refuses a foreign Origin with 403 and writes nothing (%s)",
    async (_n, allowedHosts, host) => {
      const guarded = appFor({ deps, identify, ...(allowedHosts && { allowedHosts }) });
      const body = {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "save_link", arguments: { url: "https://example.com/o" } },
      };
      const evil = await post(guarded, "key-a", body, { host, origin: "http://evil.example" });
      expect(evil.status).toBe(403);
      expect(linkCount(db)).toBe(0);
      const noOrigin = await post(guarded, "key-a", body, { host });
      expect(noOrigin.status).toBe(200);
      expect(linkCount(db)).toBe(1);
    },
  );

  it("refuses a foreign Host unless allowedHosts lists it", async () => {
    const body = { jsonrpc: "2.0", id: 5, method: "tools/list" };
    expect((await post(app, "key-a", body, { host: "links.example.ts.net" })).status).toBe(403);
    const open = appFor({ deps, identify, allowedHosts: ["links.example.ts.net"] });
    expect((await post(open, "key-a", body, { host: "links.example.ts.net" })).status).toBe(200);
    expect((await post(open, "key-a", body, { host: "localhost" })).status).toBe(403);
  });

  it("serves a modern (2026-07-28) tools/call", async () => {
    const res = await post(
      app,
      "key-a",
      {
        jsonrpc: "2.0",
        id: 77,
        method: "tools/call",
        params: {
          name: "save_link",
          arguments: { url: "https://example.com/modern" },
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      },
      { "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/call", "mcp-name": "save_link" },
    );
    expect(res.status).toBe(200);
    expect(res.body.result.structuredContent.link.url).toBe("https://example.com/modern");
    expect(res.body.result.structuredContent.link.savedBy).toBe("claude-code");
  });

  describe("profile tools", () => {
    const noteTexts = (r: Rpc) => r.body.result.structuredContent.notes.map((n: Json) => n.text);
    const profileOf = (key: string) => call(app, key, "get_profile", {});

    it("every profile tool equals the direct core call with the same clock", async () => {
      const add = {
        addNotes: [
          { text: "likes long reads", source: "inferred" as const },
          { text: "plans a battery install", source: "stated" as const },
        ],
        addFocus: [{ text: "heat pumps", source: "asked" as const }],
      };
      const viaDoor = await call(app, "key-a", "add_profile", add);
      const direct1 = await addProfile(direct, A.owner, A.savedBy, add);
      expect(viaDoor.body.result.structuredContent).toEqual(wire(direct1));
      expect(Object.keys(viaDoor.body.result.structuredContent).sort()).toEqual([
        "addedFocusIds",
        "addedNoteIds",
        "notes",
        "recentFocus",
      ]);

      const edit = {
        editNotes: [{ id: "1", text: "maybe likes long reads", source: "inferred" as const }],
        removeNotes: ["2"],
      };
      const edited = await call(app, "key-a", "edit_profile", edit);
      const direct2 = await editProfile(direct, A.owner, A.savedBy, edit);
      expect(edited.body.result.structuredContent).toEqual(wire(direct2));
      expect(Object.keys(edited.body.result.structuredContent).sort()).toEqual([
        "notes",
        "recentFocus",
      ]);

      const got = await profileOf("key-a");
      expect(got.body.result.structuredContent).toEqual(wire(await getProfile(direct, A.owner)));
      expect(Object.keys(got.body.result.structuredContent).sort()).toEqual([
        "activeProjects",
        "notes",
        "recentFocus",
      ]);
    });

    it("returns inferred notes and focus with their label over the wire", async () => {
      await call(app, "key-a", "add_profile", {
        addNotes: [{ text: "guess", source: "inferred" }],
        addFocus: [{ text: "focus guess", source: "inferred" }],
      });
      const got = await profileOf("key-a");
      expect(got.body.result.structuredContent.notes[0]).toMatchObject({
        text: "guess",
        source: "inferred",
        writtenBy: "claude-code",
      });
      expect(got.body.result.structuredContent.recentFocus[0]).toMatchObject({
        text: "focus guess",
        source: "inferred",
      });
    });

    it("lists active projects in get_profile, and puts only notes and focus in save_link's profile", async () => {
      await call(app, "key-a", "save_link", {
        url: "https://example.com/p1",
        tags: [{ name: "Launch", source: "stated", kind: "project" }],
      });
      await call(app, "key-a", "add_profile", { addNotes: [{ text: "n", source: "stated" }] });
      const got = await profileOf("key-a");
      expect(got.body.result.structuredContent.activeProjects.map((t: Json) => t.key)).toEqual([
        "launch",
      ]);
      const saved = await call(app, "key-a", "save_link", { url: "https://example.com/p2" });
      const profile = saved.body.result.structuredContent.profile;
      expect(Object.keys(profile).sort()).toEqual(["notes", "recentFocus"]);
      expect(profile.notes.map((n: Json) => n.text)).toEqual(["n"]);
    });

    it("takes the writer from the key and ignores owner and writtenBy arguments", async () => {
      const res = await call(app, "key-a", "add_profile", {
        addNotes: [{ text: "mine", source: "stated" }],
        writtenBy: "evil",
        owner: B.owner,
      });
      expect(res.body.result.structuredContent.notes[0].writtenBy).toBe("claude-code");
      expect(noteTexts(await profileOf("key-b"))).toEqual([]);
      expect(noteTexts(await profileOf("key-a"))).toEqual(["mine"]);
    });

    it("refuses a stray argument to get_profile instead of serving another owner", async () => {
      await call(app, "key-b", "add_profile", { addNotes: [{ text: "secret", source: "stated" }] });
      const res = await call(app, "key-a", "get_profile", { owner: B.owner });
      expect(res.body.result.isError).toBe(true);
      expect(JSON.stringify(res.body)).not.toContain("secret");
    });

    it("keeps owners apart on edit and remove", async () => {
      await call(app, "key-b", "add_profile", { addNotes: [{ text: "b-only", source: "stated" }] });
      const edit = await call(app, "key-a", "edit_profile", {
        editNotes: [{ id: "1", text: "hijack", source: "stated" }],
      });
      const remove = await call(app, "key-a", "edit_profile", { removeNotes: ["1"] });
      for (const r of [edit, remove]) {
        expect(r.body.result.isError).toBe(true);
        expect(r.body.result.content[0].text).toContain("No profile note");
      }
      expect(noteTexts(await profileOf("key-b"))).toEqual(["b-only"]);
    });

    it("refuses an inferred edit of a stated note and leaves it as it was", async () => {
      await call(app, "key-a", "add_profile", { addNotes: [{ text: "fact", source: "stated" }] });
      const res = await call(app, "key-a", "edit_profile", {
        editNotes: [{ id: "1", text: "guess", source: "inferred" }],
      });
      expect(res.body.result.isError).toBe(true);
      expect(res.body.result.content[0].text).toContain("add_profile");
      const got = await profileOf("key-a");
      expect(got.body.result.structuredContent.notes[0]).toMatchObject({
        text: "fact",
        source: "stated",
      });
    });

    it("refuses over-long text with a message naming the cap, and writes nothing", async () => {
      const note = await call(app, "key-a", "add_profile", {
        addNotes: [{ text: "x".repeat(1001), source: "stated" }],
      });
      const focus = await call(app, "key-a", "add_profile", {
        addFocus: [{ text: "x".repeat(501), source: "stated" }],
      });
      expect(note.body.result.content[0].text).toContain("1000");
      expect(focus.body.result.content[0].text).toContain("500");
      expect(note.body.result.isError && focus.body.result.isError).toBe(true);
      const got = await profileOf("key-a");
      expect(got.body.result.structuredContent.notes).toEqual([]);
      expect(got.body.result.structuredContent.recentFocus).toEqual([]);
    });

    it("refuses a bad source before writing anything", async () => {
      const res = await call(app, "key-a", "add_profile", {
        addNotes: [{ text: "n", source: "guessed" }],
      });
      expect(res.body.result?.isError ?? Boolean(res.body.error)).toBe(true);
      expect(noteTexts(await profileOf("key-a"))).toEqual([]);
    });

    it("reports a committed add as success even when every later read fails, so a retry cannot duplicate it", async () => {
      const failing = {
        apply: deps.profile.apply.bind(deps.profile),
        listNotes: async () => {
          throw new Error("read after write");
        },
        recentFocus: async () => {
          throw new Error("read after write");
        },
      };
      const broken = appFor({ deps: { ...deps, profile: failing }, identify });
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const res = await call(broken, "key-a", "add_profile", {
          addNotes: [{ text: "once", source: "stated" }],
        });
        expect(res.body.result.isError).toBeUndefined();
        expect(res.body.result.structuredContent.notes.map((n: Json) => n.text)).toEqual(["once"]);
      } finally {
        spy.mockRestore();
      }
      expect(noteTexts(await profileOf("key-a"))).toEqual(["once"]);
    });
  });
});
