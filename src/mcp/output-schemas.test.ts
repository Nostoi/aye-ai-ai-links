import { readFileSync } from "node:fs";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/server";
import {
  Ajv,
  AjvJsonSchemaValidator,
  addFormats,
} from "@modelcontextprotocol/server/validators/ajv";
import type { Hono } from "hono";
import { beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import type { z } from "zod";
import { createApp } from "../app.js";
import type { Caller } from "../auth/caller.js";
import type { getDigest } from "../core/digest.js";
import type { filingContext } from "../core/filing-context.js";
import type { getLinkWithText, saveLink, updateLink } from "../core/links.js";
import type { listLinks } from "../core/list-links.js";
import type { addProfile, editProfile, getProfile, profileContext } from "../core/profile.js";
import type { searchLinks } from "../core/search-links.js";
import type { changeTagKind } from "../core/tag-kind.js";
import { type HandyView, keepHandy, notHandy } from "../core/tools.js";
import type { Link, Tag } from "../core/types.js";
import { createDeps } from "../deps.js";
import { FakeEmbedder } from "../search/embedder.js";
import { DIMS } from "../search/model.js";
import { openDatabase } from "../store/database.js";
import {
  type addProfileOutput,
  type getDigestOutput,
  getLinkOutput,
  type getProfileOutput,
  type linkOutput,
  type linkResultOutput,
  type listLinksOutput,
  type profileOutput,
  saveLinkOutput,
  type searchLinksOutput,
  type tagOutput,
  type updateTagOutput,
} from "./output-schemas.js";
import { buildMcpServer } from "./server.js";

const A: Caller = { owner: "owner-a", savedBy: "claude-code" };
const NOW = new Date("2026-10-11T12:00:00.000Z");
const DAY = 86_400_000;

// biome-ignore lint/suspicious/noExplicitAny: the tests read untyped JSON-RPC bodies
type Json = any;
type Era = "2025" | "2026";
const ERAS: Era[] = ["2025", "2026"];

function freshApp() {
  const db = openDatabase(":memory:");
  const deps = { ...createDeps(db, new FakeEmbedder(DIMS)), now: () => NOW };
  deps.store.ensureUser(A.owner, A.owner);
  const app = createApp({ deps, identify: async () => ({ ...A, rateKey: "a" }) }).app;
  return { db, deps, app };
}

let rpcId = 0;
/** One JSON-RPC request in the 2025 stateless form or the 2026-07-28 form. */
async function rpc(app: Hono, era: Era, method: string, params: Record<string, unknown> = {}) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    host: "localhost",
  };
  let body = params;
  if (era === "2026") {
    headers["mcp-protocol-version"] = "2026-07-28";
    headers["mcp-method"] = method;
    if (typeof params.name === "string") headers["mcp-name"] = params.name;
    body = {
      ...params,
      _meta: {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientCapabilities": {},
      },
    };
  }
  const res = await app.fetch(
    new Request("http://localhost/mcp", {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params: body }),
    }),
  );
  const text = await res.text();
  const data = text.split("\n").find((l) => l.startsWith("data:"));
  return JSON.parse(data ? data.slice(5) : text) as Json;
}

const listTools = async (app: Hono, era: Era): Promise<Json[]> =>
  (await rpc(app, era, "tools/list")).result.tools;

const callTool = (app: Hono, era: Era, name: string, args: unknown) =>
  rpc(app, era, "tools/call", { name, arguments: args });

type Step = { tool: string; args: unknown };
const save = (args: Record<string, unknown>): Step => ({ tool: "save_link", args });
const update = (args: Record<string, unknown>): Step => ({ tool: "update_link", args });
const get = (id: string): Step => ({ tool: "get_link", args: { id } });
const search = (query: string): Step => ({ tool: "search_links", args: { query } });
const list = (args: Record<string, unknown> = {}): Step => ({ tool: "list_links", args });
const retag = (name: string, kind: string): Step => ({ tool: "update_tag", args: { name, kind } });
const addToProfile = (args: Record<string, unknown>): Step => ({ tool: "add_profile", args });
const editProfileStep = (args: Record<string, unknown>): Step => ({ tool: "edit_profile", args });
const getProfileStep: Step = { tool: "get_profile", args: {} };
const digestStep: Step = { tool: "get_digest", args: {} };

/** A copy of `value` with one unknown key added to every plain object in it, as a later server version might send. */
function withAddedField(value: Json): { value: Json; added: number } {
  let added = 0;
  const widen = (v: Json): Json => {
    if (Array.isArray(v)) return v.map(widen);
    if (v === null || typeof v !== "object") return v;
    added += 1;
    return {
      ...Object.fromEntries(Object.entries(v).map(([k, x]) => [k, widen(x)])),
      addedLater: 1,
    };
  };
  return { value: widen(value), added };
}

const UPPER = "9999-12-31T23:59:59-01:00"; // serializes as "+010000-01-01T00:59:59.000Z"
const LOWER = "0000-01-01T00:00:00+01:00"; // serializes as "-000001-12-31T23:00:00.000Z"

describe.each(ERAS)("output schemas, %s era", (era) => {
  let db: ReturnType<typeof openDatabase>;
  let deps: ReturnType<typeof freshApp>["deps"];
  let app: Hono;
  beforeEach(() => {
    ({ db, deps, app } = freshApp());
  });

  it("every listed tool declares an object-rooted outputSchema", async () => {
    const tools = await listTools(app, era);
    expect(tools.map((t) => t.name).sort()).toEqual([
      "add_profile",
      "edit_profile",
      "get_digest",
      "get_link",
      "get_profile",
      "list_links",
      "save_link",
      "search_links",
      "update_link",
      "update_tag",
    ]);
    for (const t of tools) {
      expect(t.outputSchema, t.name).toBeDefined();
      expect(t.outputSchema.type, t.name).toBe("object");
    }
  });

  it("real results conform to the advertised schema, with every nullable and variant branch reached", async () => {
    const tools = Object.fromEntries((await listTools(app, era)).map((t) => [t.name, t]));
    const validators = new AjvJsonSchemaValidator();
    const sampled = new Set<string>();
    const outputs: Json[] = [];

    const run = async ({ tool, args }: Step) => {
      const res = (await callTool(app, era, tool, args)).result;
      expect(res.isError, `${tool}: ${JSON.stringify(res)}`).toBeUndefined();
      expect(tools[tool].outputSchema, `${tool} declares an outputSchema`).toBeDefined();
      const check = validators.getValidator(tools[tool].outputSchema);
      const verdict = check(res.structuredContent);
      expect(verdict.valid, `${tool}: ${JSON.stringify(verdict)}`).toBe(true);
      expect(JSON.parse(res.content[0].text)).toEqual(res.structuredContent);
      sampled.add(tool);
      outputs.push(res.structuredContent);
      return res.structuredContent;
    };

    await run(
      save({
        url: "https://example.com/a",
        title: "A",
        summary: "A page",
        why: { text: "for the launch", source: "stated" },
        tags: [
          { name: "Reading", source: "asked", kind: "topic" },
          { name: "Aye Launch", source: "inferred", kind: "project" },
          { name: "Side", source: "stated", kind: "project" },
        ],
      }),
    );
    await run(save({ url: "https://example.com/b" }));
    await run(save({ url: "https://example.com/a" }));
    await run(
      update({ id: "1", snoozedUntil: "2026-10-20T00:00:00Z", opened: true, state: "archived" }),
    );
    // Values no tool sets: reach them through the database handle.
    db.prepare("UPDATE links SET last_surfaced_at = ? WHERE id = 1").run(NOW.getTime());
    db.prepare(
      "UPDATE tags SET color = 'blue', description = 'Things to read', pinned = 1 WHERE key = 'reading'",
    ).run();
    db.prepare("UPDATE tags SET project_status = 'done' WHERE key = 'aye launch'").run();
    db.prepare("UPDATE tags SET project_status = 'active' WHERE key = 'side'").run();
    // Snapshot rows no tool writes yet: one fetched, one failed, a third deleted below, the rest pending.
    db.prepare(
      `UPDATE snapshots SET fetch_status = 'ok', fetched_at = ?, title = 'Page', description = 'About',
         image_url = 'https://example.com/i.png' WHERE link_id = 1`,
    ).run(NOW.getTime());
    db.prepare("UPDATE snapshots SET fetch_status = 'extract_timeout' WHERE link_id = 2").run();
    // Text longer than save's cap and shorter than get's: truncated both ways.
    db.prepare("UPDATE snapshots SET text = ? WHERE link_id = 1").run("t".repeat(600));
    await run(get("1"));
    await run(save({ url: "https://example.com/a" }));
    await run(save({ url: "https://example.com/c" })); // its filingContext holds the seeded tags
    db.prepare("DELETE FROM snapshots WHERE link_id = 3").run();
    await run(update({ id: "1", why: null, summary: null }));
    await run(search(""));
    await run(search("zzzznomatch"));
    const firstPage = await run(list({ limit: 1 }));
    const lastPage = await run(list({ order: "oldest" }));
    await run(list({ order: "opened", state: "active" }));
    expect(firstPage).toMatchObject({ total: 3, nextCursor: expect.any(String) });
    expect(lastPage).toMatchObject({ total: 3, nextCursor: null });
    // Timestamps whose JSON form is outside the four-digit ISO range stay readable.
    await run(update({ id: "2", snoozedUntil: UPPER }));
    await run(update({ id: "3", snoozedUntil: LOWER }));
    await run(get("2"));
    await run(get("3"));
    await run(search(""));
    await run(save({ url: "https://example.com/b" }));
    await run(retag("Reading", "project"));
    await run(retag("Aye Launch", "topic"));
    await run(retag("Aye Launch", "topic"));
    await run(getProfileStep); // empty profile
    await run(
      addToProfile({
        addNotes: [
          { text: "plans a home battery install", source: "stated" },
          { text: "likes long reads", source: "inferred" },
        ],
        addFocus: [{ text: "comparing battery quotes", source: "asked" }],
      }),
    );
    await run(
      editProfileStep({ editNotes: [{ id: "2", text: "reads long essays", source: "inferred" }] }),
    );
    await run(editProfileStep({ removeNotes: ["2"] }));
    await run(getProfileStep);
    await run(save({ url: "https://example.com/d" })); // its profile holds notes and focus
    // A digest reaching every reason: link 5 matches the inferred focus entry, link 3 is old
    // with no why, and link 4 is new with no why.
    await run(
      save({ url: "https://example.com/e", title: "Quokka", why: { text: "w", source: "stated" } }),
    );
    await run(addToProfile({ addFocus: [{ text: "quokka", source: "inferred" }] }));
    db.prepare("UPDATE links SET saved_at = ? WHERE id = 3").run(NOW.getTime() - 60 * 86_400_000);
    // Keep handy rows: 6 kept and due (never opened), 7 suggested, 8 declined, 9 kept and due (opened
    // 45 days ago). 7 and 8 are ordinary links, so they are shown recently enough to stay out.
    const w = { text: "w", source: "stated" };
    for (const path of ["f", "g", "h", "i"]) {
      await run(save({ url: `https://example.com/${path}`, why: w }));
    }
    await keepHandy(deps, A.owner, "6", "stated");
    await keepHandy(deps, A.owner, "7", "inferred");
    await notHandy(deps, A.owner, "8", "asked");
    await keepHandy(deps, A.owner, "9", "asked");
    db.prepare("UPDATE link_tools SET since = ? WHERE link_id IN (6, 9)").run(
      NOW.getTime() - 40 * DAY,
    );
    db.prepare("UPDATE links SET last_opened_at = ? WHERE id = 9").run(NOW.getTime() - 45 * DAY);
    db.prepare("UPDATE links SET last_surfaced_at = ? WHERE id IN (7, 8)").run(NOW.getTime());
    await run(list({ limit: 50 }));
    const digest = await run(digestStep); // the reading picks, then one check
    const secondDigest = await run(digestStep); // only the other due tool's check
    const emptyDigest = await run(digestStep); // everything due was just surfaced

    expect([...sampled].sort()).toEqual(Object.keys(tools).sort());

    expect(emptyDigest).toEqual({ links: [] });
    expect(digest.links.map((d: Json) => [d.link.id, d.reasons.map((r: Json) => r.kind)])).toEqual([
      ["5", ["focus_words", "never_surfaced"]],
      ["3", ["no_why", "not_opened_recently", "never_surfaced"]],
      ["4", ["no_why", "never_surfaced"]],
      ["6", ["still_using_check"]],
    ]);
    expect(digest.links[3].reasons[0]).toEqual({
      kind: "still_using_check",
      daysSinceOpened: null,
    });
    expect(secondDigest.links.map((d: Json) => [d.link.id, d.reasons])).toEqual([
      ["9", [{ kind: "still_using_check", daysSinceOpened: 45 }]],
    ]);
    expect(digest.links[0].reasons[0].focus).toMatchObject({ text: "quokka", source: "inferred" });

    const links: Json[] = outputs
      .flatMap((o) => [o.link, ...(o.links ?? []).map((x: Json) => x.link ?? x)])
      .filter(Boolean);
    const tagsSeen: Json[] = outputs
      .flatMap((o) => [
        o.tag,
        ...(o.filingContext?.tags ?? []),
        ...(o.filingContext?.activeProjects ?? []),
      ])
      .filter(Boolean);
    const values = (xs: Json[], pick: (x: Json) => unknown) => new Set(xs.map(pick));
    for (const field of [
      "title",
      "summary",
      "why",
      "lastOpenedAt",
      "lastSurfacedAt",
      "snoozedUntil",
    ]) {
      const isNull = values(links, (l) => l[field] === null);
      expect(isNull, `link.${field} null and non-null`).toEqual(new Set([true, false]));
    }
    expect(values(links, (l) => l.state)).toEqual(new Set(["active", "archived"]));
    const texts: Json[] = outputs.filter((o) => "snapshotText" in o).map((o) => o.snapshotText);
    expect(values(texts, (t) => t === null)).toEqual(new Set([true, false]));
    expect(
      values(
        texts.filter((t) => t !== null),
        (t) => t.truncated,
      ),
    ).toEqual(new Set([true, false]));
    expect(values(links, (l) => l.handy === null)).toEqual(new Set([true, false]));
    const views = links.map((l) => l.handy).filter(Boolean);
    expect(values(views, (h) => h.status)).toEqual(new Set(["kept", "suggested", "declined"]));
    expect(values(views, (h) => h.source)).toEqual(new Set(["stated", "asked", "inferred"]));
    expect(values(views, (h) => h.due)).toEqual(new Set([true, false]));
    expect(values(links, (l) => l.snapshot === null)).toEqual(new Set([true, false]));
    const snapshots = links.map((l) => l.snapshot).filter(Boolean);
    expect(values(snapshots, (x) => x.status)).toEqual(
      new Set(["pending", "ok", "extract_timeout"]),
    );
    for (const field of ["fetchedAt", "title", "description", "imageUrl"]) {
      expect(
        values(snapshots, (x) => x[field] === null),
        `snapshot.${field}`,
      ).toEqual(new Set([true, false]));
    }
    expect(values(links, (l) => l.why?.source)).toContain("stated");
    expect(
      values(
        links.flatMap((l) => l.tags),
        (t) => t.source,
      ),
    ).toEqual(new Set(["asked", "inferred", "stated"]));
    expect(
      values(
        links.flatMap((l) => l.tags),
        (t) => t.kind,
      ),
    ).toEqual(new Set(["topic", "project"]));
    const allKindSources = new Set(["stated", "asked", "inferred"]);
    expect(
      values(
        links.flatMap((l) => l.tags),
        (t) => t.kindSource,
      ),
    ).toEqual(allKindSources);
    expect(values(tagsSeen, (t) => t.kindSource)).toEqual(allKindSources);
    expect(values(links, (l) => l.tags.length === 0)).toEqual(new Set([true, false]));
    expect(values(tagsSeen, (t) => t.projectStatus)).toEqual(new Set([null, "active", "done"]));
    for (const field of ["color", "description"]) {
      expect(
        values(tagsSeen, (t) => t[field] === null),
        `tag.${field}`,
      ).toEqual(new Set([true, false]));
    }
    expect(values(tagsSeen, (t) => t.pinned)).toEqual(new Set([true, false]));
    expect(values(tagsSeen, (t) => t.kind)).toEqual(new Set(["topic", "project"]));
    const profiles: Json[] = outputs.filter((o) => o.profile || o.notes).map((o) => o.profile ?? o);
    expect(values(profiles, (p) => p.notes.length === 0)).toEqual(new Set([true, false]));
    expect(values(profiles, (p) => p.recentFocus.length === 0)).toEqual(new Set([true, false]));
    expect(
      values(
        profiles.flatMap((p) => p.notes),
        (n) => n.source,
      ),
    ).toEqual(new Set(["stated", "inferred"]));
    expect(
      values(
        outputs.filter((o) => "created" in o),
        (o) => o.created,
      ),
    ).toEqual(new Set([true, false]));
    expect(
      values(
        outputs.filter((o) => "links" in o),
        (o) => o.links.length === 0,
      ),
    ).toEqual(new Set([true, false]));
  });

  it("a session that cached tools/list accepts a result with an added field at every level", async () => {
    const tools: Record<string, Json> = Object.fromEntries(
      (await listTools(app, era)).map((t) => [t.name, t]),
    );
    // A TS SDK v1 client compiles each listed outputSchema like this and keeps it until it lists again.
    const ajv = new Ajv({
      strict: false,
      validateFormats: true,
      validateSchema: false,
      allErrors: true,
    });
    addFormats(ajv);
    const cached = Object.fromEntries(
      Object.entries(tools).map(([name, t]) => [name, ajv.compile(t.outputSchema)]),
    );
    const sampled = new Set<string>();

    const run = async ({ tool, args }: Step) => {
      const res = (await callTool(app, era, tool, args)).result;
      expect(res.isError, `${tool}: ${JSON.stringify(res)}`).toBeUndefined();
      const { value, added } = withAddedField(res.structuredContent);
      expect(added, `${tool} has nested objects to widen`).toBeGreaterThan(1);
      const check = cached[tool];
      expect(check?.(value), `${tool}: ${ajv.errorsText(check?.errors)}`).toBe(true);
      sampled.add(tool);
      return value;
    };

    const saved = await run(
      save({
        url: "https://example.com/a",
        why: { text: "for the launch", source: "stated" },
        tags: [{ name: "Aye Launch", source: "inferred", kind: "project" }],
      }),
    );
    await run(update({ id: "1", summary: "s" }));
    await run(get("1"));
    await run(search(""));
    await run(list());
    await run(retag("Aye Launch", "topic"));
    await run(
      addToProfile({
        addNotes: [{ text: "plans a home battery install", source: "stated" }],
        addFocus: [
          { text: "comparing battery quotes", source: "asked" },
          { text: "launch", source: "inferred" },
        ],
      }),
    );
    await run(
      editProfileStep({ editNotes: [{ id: "1", text: "plans a battery", source: "stated" }] }),
    );
    await run(getProfileStep);
    const digest = await run(digestStep);
    expect(digest.links[0].reasons[0].focus.addedLater).toBe(1);
    expect([...sampled].sort()).toEqual(Object.keys(tools).sort());

    // Enums stay closed: a new enum value is still a contract change.
    // With snapshotText present, only the unknown enum value can make the second one fail.
    const got = { link: saved.link, snapshotText: null };
    expect(cached.get_link?.(got)).toBe(true);
    expect(cached.get_link?.({ ...got, link: { ...saved.link, state: "deleted" } })).toBe(false);
  });

  it.each([
    ["get_link with an unknown id", get("999")],
    ["update_link with an unknown id", update({ id: "999", summary: "x" })],
    ["save_link with a credentialed URL", save({ url: "https://user:pw@example.com/x" })],
    [
      "search_links with a fractional limit",
      { tool: "search_links", args: { query: "", limit: 1.5 } },
    ],
    ["list_links with a cursor it never made", list({ cursor: "1000.999" })],
    ["update_tag with an unknown tag", retag("nope", "topic")],
  ])("%s is a text-only error", async (_name, { tool, args }) => {
    const res = (await callTool(app, era, tool, args)).result;
    expect(res.isError).toBe(true);
    expect(res.structuredContent).toBeUndefined();
    expect(res.content[0].type).toBe("text");
    expect(res.content[0].text.length).toBeGreaterThan(0);
  });

  it("an unknown tool is a JSON-RPC error, not a tool result", async () => {
    const res = await callTool(app, era, "missing_tool", {});
    expect(res.result).toBeUndefined();
    expect(res.error.code).toBe(-32602);
  });
});

describe.each(ERAS)("a result that breaks its schema after a write, %s era", (era) => {
  // The advertised schema allows extra keys, so the server's own check is what must refuse them.
  it.each([
    ["an extra key on the link", (link: Link) => ({ ...link, stray: 1 })],
    [
      "an extra key inside a tag",
      (link: Link) => ({ ...link, tags: link.tags.map((t) => ({ ...t, stray: 1 })) }),
    ],
  ])(
    "with %s is logged and tells the agent the change was saved and must not be retried",
    async (_name, spoil) => {
      const { db, deps, app } = freshApp();
      await callTool(app, era, "save_link", {
        url: "https://example.com/a",
        tags: [{ name: "Reading", source: "stated" }],
      });
      const realUpdate = deps.store.update.bind(deps.store);
      const update = vi.spyOn(deps.store, "update").mockImplementation(async (...args) => {
        const link = await realUpdate(...args);
        return link && (spoil(link) as Link);
      });
      const logged = vi.spyOn(console, "error").mockImplementation(() => {});

      const res = (await callTool(app, era, "update_link", { id: "1", summary: "kept" })).result;

      expect(update).toHaveBeenCalledTimes(1);
      expect(db.prepare("SELECT summary FROM links WHERE id = 1").get()).toEqual({
        summary: "kept",
      });
      expect(logged).toHaveBeenCalledTimes(1);
      expect(String(logged.mock.calls[0]?.[0])).toContain("output schema");
      expect(JSON.stringify(logged.mock.calls[0]?.[1])).toContain("stray");
      expect(res.isError).toBe(true);
      expect(res.structuredContent).toBeUndefined();
      expect(res.content[0].text).toContain("was saved");
      expect(res.content[0].text).toContain("Do not retry");
      expect(res.content[0].text).not.toContain("Output validation error");
      logged.mockRestore();
    },
  );
});

describe.each(ERAS)("a session holding main's tools/list from before #31, %s era", (era) => {
  // Captured from tools/list before any #31 change; both eras advertised the same schemas.
  const frozen = JSON.parse(
    readFileSync(join(import.meta.dirname, "fixtures/pre-31-output-schemas.json"), "utf8"),
  );

  it("accepts save_link and get_link results that carry page text (D9)", async () => {
    expect(frozen.save_link.properties.snapshotText).toBeUndefined();
    expect(frozen.get_link.properties.snapshotText).toBeUndefined();
    const ajv = new Ajv({
      strict: false,
      validateFormats: true,
      validateSchema: false,
      allErrors: true,
    });
    addFormats(ajv);
    const { db, app } = freshApp();
    await callTool(app, era, "save_link", { url: "https://example.com/a" });
    db.prepare(
      `UPDATE snapshots SET fetch_status = 'ok', next_fetch_at = NULL, fetched_at = ?,
         title = 'Page', text = ? WHERE link_id = 1`,
    ).run(NOW.getTime(), "body ".repeat(200));
    const results = {
      save_link: (await callTool(app, era, "save_link", { url: "https://example.com/a" })).result,
      get_link: (await callTool(app, era, "get_link", { id: "1" })).result,
    };
    expect(results.save_link.structuredContent.snapshotText?.truncated).toBe(true);
    expect(results.get_link.structuredContent.snapshotText?.truncated).toBe(false);
    for (const [tool, res] of Object.entries(results)) {
      const check = ajv.compile(frozen[tool]);
      expect(check(res.structuredContent), `${tool}: ${ajv.errorsText(check.errors)}`).toBe(true);
    }
  });
});

describe("page text stays strict on the server (D11)", () => {
  const link = { snapshot: null } as unknown;
  it.each([
    ["saveLinkOutput", saveLinkOutput],
    ["getLinkOutput", getLinkOutput],
  ])("%s refuses an extra key inside snapshotText", (_name, schema) => {
    const stray = { text: "t", truncated: false, stray: 1 };
    const issues = schema.safeParse({ link, snapshotText: stray }).error?.issues ?? [];
    expect(issues.some((i) => i.code === "unrecognized_keys" && i.path[0] === "snapshotText")).toBe(
      true,
    );
  });
});

/** The JSON paths of object nodes in a JSON Schema that do not say `additionalProperties: false`. */
function openObjects(node: unknown, path: string): string[] {
  if (Array.isArray(node)) return node.flatMap((n, i) => openObjects(n, `${path}[${i}]`));
  if (node === null || typeof node !== "object") return [];
  const obj = node as Record<string, unknown>;
  const here =
    (obj.type === "object" || "properties" in obj) && obj.additionalProperties !== false
      ? [path]
      : [];
  return [
    ...here,
    ...Object.entries(obj).flatMap(([key, child]) => {
      // Property names and $defs keys are labels, not keywords: look at what they hold.
      if (key === "properties" || key === "$defs" || key === "definitions") {
        return Object.entries(child as object).flatMap(([name, sub]) =>
          openObjects(sub, `${path}.${key}.${name}`),
        );
      }
      return openObjects(child, `${path}.${key}`);
    }),
  ];
}

describe("output schemas stay strict on the server", () => {
  // Walk what the server registers, not what output-schemas.ts exports: a root schema written
  // inline, or kept in another module, would escape a walk over the exports.
  const register = vi.spyOn(McpServer.prototype, "registerTool");
  buildMcpServer({} as never, A);
  const tools = register.mock.calls.map(([name, cfg]) => [name, cfg] as const);
  register.mockRestore();

  it("finds the registered tools", () => {
    expect(tools.length).toBeGreaterThan(0);
  });

  // `advertisedOpen` strips `additionalProperties: false` from what clients see, so only the
  // strict schema's own JSON form shows a plain `z.object`. Input mode tells them apart:
  // output mode closes both. `advertisedOpen` passes input mode through unchanged.
  it.each(tools)("%s closes every object node of its output schema", (name, cfg) => {
    const schema = cfg.outputSchema as z.ZodType | undefined;
    expect(schema, `${name} declares an outputSchema`).toBeDefined();
    const json = schema?.["~standard"].jsonSchema.input({ target: "draft-2020-12" });
    expect(openObjects(json, "$"), `${name}: objects that accept extra keys`).toEqual([]);
  });
});

/** What `ok()` does to a value: a JSON round trip, so Dates become strings. */
type Wire<T> = T extends Date
  ? string
  : T extends (infer U)[]
    ? Wire<U>[]
    : T extends object
      ? { [K in keyof T]: Wire<T[K]> }
      : T;
/** What the door adds to each link it returns: its Keep handy view. */
type Handied<T> = T extends Date
  ? T
  : T extends Link
    ? T & { handy: HandyView | null }
    : T extends (infer U)[]
      ? Handied<U>[]
      : T extends object
        ? { [K in keyof T]: Handied<T[K]> }
        : T;
type Returned<F extends (...args: never[]) => Promise<unknown>> = Awaited<ReturnType<F>>;

describe("output schemas against core's types (checked by tsc)", () => {
  it("each schema's output type is the wire form of what its tool returns", () => {
    expectTypeOf<z.output<typeof linkOutput>>().toEqualTypeOf<Wire<Handied<Link>>>();
    expectTypeOf<z.output<typeof tagOutput>>().toEqualTypeOf<Wire<Tag>>();
    expectTypeOf<z.output<typeof saveLinkOutput>>().toEqualTypeOf<
      Wire<
        Handied<
          Returned<typeof saveLink> & {
            filingContext: Returned<typeof filingContext>;
            profile: Returned<typeof profileContext>;
          }
        >
      >
    >();
    expectTypeOf<z.output<typeof profileOutput>>().toEqualTypeOf<
      Wire<Returned<typeof editProfile>>
    >();
    expectTypeOf<z.output<typeof getProfileOutput>>().toEqualTypeOf<
      Wire<Returned<typeof getProfile>>
    >();
    expectTypeOf<z.output<typeof addProfileOutput>>().toEqualTypeOf<
      Wire<Returned<typeof addProfile>>
    >();
    expectTypeOf<z.output<typeof linkResultOutput>>().toEqualTypeOf<
      Wire<Handied<{ link: Returned<typeof updateLink> }>>
    >();
    expectTypeOf<z.output<typeof getLinkOutput>>().toEqualTypeOf<
      Wire<Handied<Returned<typeof getLinkWithText>>>
    >();
    expectTypeOf<z.output<typeof searchLinksOutput>>().toEqualTypeOf<
      Wire<Handied<{ links: Returned<typeof searchLinks> }>>
    >();
    expectTypeOf<z.output<typeof listLinksOutput>>().toEqualTypeOf<
      Wire<
        Handied<
          Omit<Returned<typeof listLinks>, "older"> & {
            nextCursor: Returned<typeof listLinks>["older"];
          }
        >
      >
    >();
    expectTypeOf<z.output<typeof updateTagOutput>>().toEqualTypeOf<
      Wire<{ tag: Returned<typeof changeTagKind> }>
    >();
    expectTypeOf<z.output<typeof getDigestOutput>>().toEqualTypeOf<
      Wire<Handied<Returned<typeof getDigest>>>
    >();
  });
});
