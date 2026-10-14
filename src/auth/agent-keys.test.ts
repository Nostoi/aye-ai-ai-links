import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../store/database.js";
import { SqliteKeyStore } from "../store/key-store.js";
import {
  AgentKeyError,
  createAgentKey,
  generateKey,
  hashKey,
  keyIdentify,
  listAgentKeys,
  parseBearer,
  revokeAgentKey,
  turnOffAgentKey,
  turnOnAgentKey,
} from "./agent-keys.js";

type Db = Database.Database;
const open: Db[] = [];
const dirs: string[] = [];

afterEach(() => {
  for (const db of open.splice(0)) if (db.open) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function openAt(path: string): Db {
  const db = openDatabase(path);
  open.push(db);
  return db;
}

function setup() {
  const db = openAt(":memory:");
  const keys = new SqliteKeyStore(db);
  const identify = keyIdentify(keys);
  const { key } = createAgentKey(keys, { owner: "mark", ownerName: "Mark", agent: "codex" });
  return { db, keys, identify, key };
}

const asRequest = (authorization?: string) =>
  new Request("http://localhost/mcp", authorization ? { headers: { authorization } } : {});

describe("key format", () => {
  it("generates distinct aak_ keys of 32 random bytes in base64url", () => {
    const a = generateKey();
    expect(a).toMatch(/^aak_[A-Za-z0-9_-]{43}$/);
    expect(generateKey()).not.toBe(a);
  });

  it("hashes to a stable sha-256 hex digest", () => {
    expect(hashKey("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("parseBearer", () => {
  it("takes the token after a case-insensitive scheme and one or more spaces", () => {
    expect(parseBearer("Bearer aak_abc")).toBe("aak_abc");
    expect(parseBearer("bearer aak_abc")).toBe("aak_abc");
    expect(parseBearer("BEARER   aak_abc")).toBe("aak_abc");
  });

  it("refuses everything else", () => {
    for (const header of [
      null,
      "",
      "Bearer",
      "Bearer ",
      "Basic aak_abc",
      "aak_abc",
      "Bearer aak_abc extra",
      "Bearer aak_a, Bearer aak_b",
      "Bearer aak_a,aak_b",
      "Bearer abc",
      "Bearer aak_",
      "Bearer aak_a=",
      "Bearer aak_a.b",
      "Bearer aak_abc ",
      "Bearer\taak_abc",
    ]) {
      expect(parseBearer(header), String(header)).toBeNull();
    }
  });
});

describe("keyIdentify", () => {
  it("returns the owner and agent name for a valid key", async () => {
    const { identify, key } = setup();
    expect(await identify(asRequest(`Bearer ${key}`))).toEqual({
      owner: "mark",
      savedBy: "codex",
      rateKey: "key:mark/codex",
    });
    expect(await identify(asRequest(`bearer ${key}`))).toEqual({
      owner: "mark",
      savedBy: "codex",
      rateKey: "key:mark/codex",
    });
  });

  it("returns null for every invalid credential", async () => {
    const { identify, key } = setup();
    const lastChar = key.at(-1) === "A" ? "B" : "A";
    const changed = `${key.slice(0, -1)}${lastChar}`;
    const cases: Record<string, string | undefined> = {
      "missing header": undefined,
      "wrong scheme": `Basic ${key}`,
      "empty token": "Bearer ",
      "wrong key": `Bearer ${generateKey()}`,
      "one character changed": `Bearer ${changed}`,
      "comma list": `Bearer ${key}, Bearer ${generateKey()}`,
      "extra parts": `Bearer ${key} extra`,
      "bare key": key,
    };
    for (const [label, header] of Object.entries(cases)) {
      expect(await identify(asRequest(header)), label).toBeNull();
    }
  });

  it("keeps the token's case: the lower-cased key is a different key", async () => {
    const { identify, key } = setup();
    expect(await identify(asRequest(`Bearer ${key.toLowerCase()}`))).toBeNull();
  });

  it("returns null once the key is revoked, on the same handle and the next request", async () => {
    const { keys, identify, key } = setup();
    expect(await identify(asRequest(`Bearer ${key}`))).not.toBeNull();
    revokeAgentKey(keys, "mark", "codex");
    expect(await identify(asRequest(`Bearer ${key}`))).toBeNull();
  });

  it("sees a revocation made through another handle on the same file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aye-keys-"));
    dirs.push(dir);
    const path = join(dir, "test.db");
    const server = new SqliteKeyStore(openAt(path));
    const cli = new SqliteKeyStore(openAt(path));
    const identify = keyIdentify(server);
    const { key } = createAgentKey(cli, { owner: "mark", ownerName: "Mark", agent: "codex" });
    expect(await identify(asRequest(`Bearer ${key}`))).toEqual({
      owner: "mark",
      savedBy: "codex",
      rateKey: "key:mark/codex",
    });
    revokeAgentKey(cli, "mark", "codex");
    expect(await identify(asRequest(`Bearer ${key}`))).toBeNull();
  });
});

describe("key use cases", () => {
  it("stores only the hash: the plaintext key appears nowhere in agent_keys", () => {
    const { db, key } = setup();
    const rows = db.prepare("SELECT * FROM agent_keys").all() as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(key);
    expect(rows[0]?.hash).toBe(hashKey(key));
  });

  it("trims the agent name and refuses a blank one without creating the owner", () => {
    const { db, keys } = setup();
    createAgentKey(keys, { owner: "alice", ownerName: "Alice", agent: "  claude  " });
    expect(listAgentKeys(keys, "alice").map((k) => k.name)).toEqual(["claude"]);
    const before = db.prepare("SELECT count(*) AS n FROM users").get();
    for (const agent of ["", "   "]) {
      expect(() => createAgentKey(keys, { owner: "bob", ownerName: "Bob", agent })).toThrow(
        AgentKeyError,
      );
    }
    expect(db.prepare("SELECT count(*) AS n FROM users").get()).toEqual(before);
  });

  it("refuses a second live key for an agent, and revoking an unknown agent says so", () => {
    const { keys } = setup();
    expect(() =>
      createAgentKey(keys, { owner: "mark", ownerName: "Mark", agent: "codex" }),
    ).toThrow(/already has a live key/);
    expect(() => revokeAgentKey(keys, "mark", "nobody")).toThrow(AgentKeyError);
  });

  it("returns the new key's id and trimmed name with the key", () => {
    const { keys } = setup();
    const made = createAgentKey(keys, { owner: "mark", ownerName: "Mark", agent: " claude " });
    expect(made).toEqual({ id: expect.any(Number), name: "claude", key: expect.any(String) });
    expect(listAgentKeys(keys, "mark").find((k) => k.name === "claude")?.id).toBe(made.id);
    expect(keys.findLiveByHash(hashKey(made.key))).toEqual({ owner: "mark", name: "claude" });
  });
});

describe("key names", () => {
  const STAR = "\u{1F31F}";
  const make = (keys: SqliteKeyStore, agent: string) =>
    createAgentKey(keys, { owner: "bob", ownerName: "Bob", agent });

  it.each([
    ["60 characters outside the BMP", STAR.repeat(60)],
    ["60 characters with spaces around them", `  ${"a".repeat(60)}  `],
    ["a name that only starts with web", "website"],
  ])("allows %s", (_, agent) => {
    const { keys } = setup();
    expect(make(keys, agent).name).toBe(agent.trim());
  });

  it.each([
    ["61 characters outside the BMP", STAR.repeat(61), /60 characters/],
    ["61 characters", "a".repeat(61), /60 characters/],
    ["web", "web", /"web"/],
    ["Web with spaces", " Web ", /"web"/],
    ["WEB", "WEB", /"web"/],
    ["a lone high surrogate", "\ud800abc", /printable/],
    ["a lone low surrogate", "abc\udc00", /printable/],
    ["a tab inside", "a\tb", /printable/],
    ["a NUL", "a\u0000b", /printable/],
    ["a line break inside", "a\nb", /printable/],
    ["DEL", "a\u007fb", /printable/],
    ["a C1 control", "a\u0085b", /printable/],
  ])("refuses %s, writing no owner and no key", (_, agent, message) => {
    const { db, keys } = setup();
    const count = () => db.prepare("SELECT count(*) AS n FROM users").get();
    const keyRows = () => db.prepare("SELECT * FROM agent_keys ORDER BY id").all();
    const [users, rows] = [count(), keyRows()];
    expect(() => make(keys, agent)).toThrow(AgentKeyError);
    expect(() => make(keys, agent)).toThrow(message);
    expect(count()).toEqual(users);
    expect(keyRows()).toEqual(rows);
  });
});

describe("turning a key off and on by id", () => {
  const OFF = new Date("2026-10-14T12:00:00.000Z");
  const at = (ms: number) => new Date(OFF.getTime() + ms);

  function offKey() {
    const t = setup();
    const { id } = listAgentKeys(t.keys, "mark")[0] as { id: number };
    turnOffAgentKey(t.keys, "mark", id, OFF);
    return { ...t, id };
  }

  it("turns the key off at once: the next request with it is refused", async () => {
    const { keys, identify, key } = setup();
    const { id } = listAgentKeys(keys, "mark")[0] as { id: number };
    turnOffAgentKey(keys, "mark", id, OFF);
    expect(await identify(asRequest(`Bearer ${key}`))).toBeNull();
  });

  it("refuses to turn off another owner's key or one that is off, and that key stays as it was", async () => {
    const { keys, identify, key } = setup();
    const { id } = listAgentKeys(keys, "mark")[0] as { id: number };
    expect(() => turnOffAgentKey(keys, "alice", id, OFF)).toThrow(AgentKeyError);
    expect(await identify(asRequest(`Bearer ${key}`))).not.toBeNull();
    turnOffAgentKey(keys, "mark", id, OFF);
    expect(() => turnOffAgentKey(keys, "mark", id, at(1))).toThrow(AgentKeyError);
    expect(listAgentKeys(keys, "mark")[0]?.revokedAt).toEqual(OFF);
  });

  it("turns it back on within 60 seconds, and the key works again", async () => {
    const { keys, identify, key, id } = offKey();
    turnOnAgentKey(keys, "mark", id, at(60_000));
    expect(await identify(asRequest(`Bearer ${key}`))).not.toBeNull();
  });

  it("refuses after 60 seconds, and the key stays off", async () => {
    const { keys, identify, key, id } = offKey();
    expect(() => turnOnAgentKey(keys, "mark", id, at(60_001))).toThrow(AgentKeyError);
    expect(await identify(asRequest(`Bearer ${key}`))).toBeNull();
  });

  it("refuses another owner's undo, and the key stays off", async () => {
    const { keys, identify, key, id } = offKey();
    expect(() => turnOnAgentKey(keys, "alice", id, at(1))).toThrow(AgentKeyError);
    expect(await identify(asRequest(`Bearer ${key}`))).toBeNull();
  });

  it("refuses when a new key with the same name was made since; the old stays off and the new on", async () => {
    const { keys, identify, key, id } = offKey();
    const made = createAgentKey(keys, { owner: "mark", ownerName: "Mark", agent: "codex" }, at(1));
    expect(() => turnOnAgentKey(keys, "mark", id, at(2))).toThrow(/was made since/);
    expect(await identify(asRequest(`Bearer ${key}`))).toBeNull();
    expect(await identify(asRequest(`Bearer ${made.key}`))).not.toBeNull();
  });
});
