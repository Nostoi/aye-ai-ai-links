import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { issueOpenCodes, newOpenCode, OPEN_CODE_SHAPE } from "../core/open-codes.js";
import { at, newLink } from "../core/snapshot-store-contract.js";
import { createDeps } from "../deps.js";
import { FakeEmbedder } from "../search/embedder.js";
import { DIMS } from "../search/model.js";
import { openDatabase } from "./database.js";

const A = "owner-a";
const B = "owner-b";
const open: Database.Database[] = [];
afterEach(() => {
  for (const db of open.splice(0)) if (db.open) db.close();
});

function setup() {
  const db = openDatabase(":memory:");
  open.push(db);
  const deps = createDeps(db, new FakeEmbedder(DIMS));
  deps.store.ensureUser(A, A);
  deps.store.ensureUser(B, B);
  let n = 0;
  const save = async (owner = A, url?: string) => {
    const link = { ...newLink(++n, at(0)), ...(url && { url, urlKey: url }) };
    return (await deps.store.insertIfAbsent(owner, link)).link;
  };
  const rows = () =>
    db.prepare("SELECT owner_id, link_id, agent, code FROM link_open_codes ORDER BY rowid").all();
  const issue = async (
    owner: string,
    agent: string,
    ...links: Awaited<ReturnType<typeof save>>[]
  ) => issueOpenCodes({ ...deps, now: () => at(5) }, owner, links, agent);
  return { db, deps, save, rows, issue };
}

describe("open codes (#133)", () => {
  it("a new code is 128 random bits as 22 base64url characters", () => {
    const codes = new Set(Array.from({ length: 50 }, newOpenCode));
    expect(codes.size).toBe(50);
    for (const code of codes) expect(code).toMatch(OPEN_CODE_SHAPE);
  });

  it("a link's code is the same on every call for one agent, and differs by agent and by owner", async () => {
    const { save, issue, rows } = setup();
    const mine = await save(A, "https://same.example/page");
    const theirs = await save(B, "https://same.example/page");

    const first = (await issue(A, "claude", mine)).get(mine.id);
    const again = (await issue(A, "claude", mine)).get(mine.id);
    const otherAgent = (await issue(A, "codex", mine)).get(mine.id);
    const otherOwner = (await issue(B, "claude", theirs)).get(theirs.id);

    expect(first).toMatch(OPEN_CODE_SHAPE);
    expect(again).toBe(first);
    expect(new Set([first, otherAgent, otherOwner]).size).toBe(3);
    expect(rows()).toHaveLength(3);
  });

  it("two calls at once for one link and agent store one code, and both return it", async () => {
    const { deps, save, rows } = setup();
    const link = await save();
    const [one, two] = await Promise.all([
      deps.openCodes.codesFor(A, "claude", [link.id], () => "a".repeat(22), at(5)),
      deps.openCodes.codesFor(A, "claude", [link.id], () => "b".repeat(22), at(5)),
    ]);
    expect(one.get(link.id)).toBe("a".repeat(22));
    expect(two.get(link.id)).toBe("a".repeat(22));
    expect(rows()).toEqual([
      { owner_id: A, link_id: Number(link.id), agent: "claude", code: "a".repeat(22) },
    ]);
  });

  it("a link that isn't a web page gets no code, and nothing is stored for it", async () => {
    const { save, issue, rows } = setup();
    const web = await save(A, "https://ex.com/web");
    const mail = await save(A, "mailto:someone@ex.com");
    const file = await save(A, "file:///etc/passwd");

    const codes = await issue(A, "claude", web, mail, file);

    expect([...codes.keys()]).toEqual([web.id]);
    expect(rows()).toHaveLength(1);
  });

  it("another owner's link id gets no code under this owner", async () => {
    const { deps, save, rows } = setup();
    const theirs = await save(B);
    const codes = await deps.openCodes.codesFor(A, "claude", [theirs.id], newOpenCode, at(5));
    expect(codes.size).toBe(0);
    expect(rows()).toEqual([]);
  });

  it("a code finds the owner, link and agent it was made for; any other string finds nothing", async () => {
    const { deps, save, issue } = setup();
    const link = await save();
    const code = (await issue(A, "claude", link)).get(link.id) as string;

    expect(deps.openCodes.findByCode(code)).toEqual({ owner: A, linkId: link.id, agent: "claude" });
    expect(deps.openCodes.findByCode(newOpenCode())).toBeNull();
    expect(deps.openCodes.findByCode("")).toBeNull();
  });
});
