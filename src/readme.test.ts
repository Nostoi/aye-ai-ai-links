import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import type { Caller } from "./auth/caller.js";
import { createDeps } from "./deps.js";
import { FakeEmbedder } from "./search/embedder.js";
import { DIMS } from "./search/model.js";
import { openDatabase } from "./store/database.js";

const ROOT = join(import.meta.dirname, "..");
const README = readFileSync(join(ROOT, "README.md"), "utf8");
const OWNER: Caller = { owner: "owner-a", savedBy: "claude-code" };

async function listedToolNames(): Promise<string[]> {
  const db = openDatabase(":memory:");
  try {
    const deps = createDeps(db, new FakeEmbedder(DIMS));
    deps.store.ensureUser(OWNER.owner, OWNER.owner);
    const { app } = createApp({ deps, identify: async () => OWNER });
    const res = await app.fetch(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          host: "localhost",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
    );
    const text = await res.text();
    const data = text.split("\n").find((l) => l.startsWith("data:"));
    const body = JSON.parse(data ? data.slice(5) : text) as {
      result: { tools: { name: string }[] };
    };
    return body.result.tools.map((t) => t.name);
  } finally {
    db.close();
  }
}

const AGENTS = readFileSync(join(ROOT, "AGENTS.md"), "utf8");

/** The `src/` folders AGENTS.md's folder map lists: the entries indented one level under `src/`. */
function mappedSrcFolders(): { name: string; planned: boolean }[] {
  const block = AGENTS.match(/## Folder map[\s\S]*?```\n([\s\S]*?)```/)?.[1] ?? "";
  return [...block.matchAll(/^ {3}[├└]─ ([\w-]+)\/(.*)$/gm)].map((m) => ({
    name: m[1] as string,
    planned: (m[2] ?? "").includes("(planned)"),
  }));
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(path);
    return e.name.endsWith(".ts") && !e.name.endsWith(".test.ts") ? [path] : [];
  });
}

describe("README stays current", () => {
  it("names every tool the server lists, in backticks", async () => {
    const tools = await listedToolNames();
    expect(tools.length).toBeGreaterThan(0);
    const missing = tools.filter((name) => !README.includes(`\`${name}\``));
    expect(
      missing,
      `README.md does not name these tools in backticks: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("names every AYE_ environment variable the code reads", () => {
    const vars = new Set<string>();
    for (const file of sourceFiles(join(ROOT, "src"))) {
      for (const m of readFileSync(file, "utf8").matchAll(/\bAYE_[A-Z0-9_]+\b/g)) vars.add(m[0]);
    }
    expect([...vars]).toContain("AYE_DB");
    const missing = [...vars].filter((v) => !new RegExp(`\\b${v}\\b`).test(README));
    expect(missing, `README.md does not name these variables: ${missing.join(", ")}`).toEqual([]);
  });

  it("AGENTS.md's folder map names every direct child folder of src/, and lists no missing one unless planned", () => {
    const mapped = mappedSrcFolders();
    expect(mapped.length).toBeGreaterThan(0);
    const named = new Set(mapped.map((f) => f.name));
    const actual = readdirSync(join(ROOT, "src"), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
    const unmapped = actual.filter((name) => !named.has(name));
    expect(
      unmapped,
      `AGENTS.md's folder map does not name these src/ folders: ${unmapped.join(", ")}`,
    ).toEqual([]);
    const gone = mapped.filter((f) => !f.planned && !actual.includes(f.name)).map((f) => f.name);
    expect(
      gone,
      `AGENTS.md's folder map lists these src/ folders, which do not exist and are not marked (planned): ${gone.join(", ")}`,
    ).toEqual([]);
    const built = mapped.filter((f) => f.planned && actual.includes(f.name)).map((f) => f.name);
    expect(
      built,
      `AGENTS.md's folder map still marks these existing src/ folders (planned): ${built.join(", ")}`,
    ).toEqual([]);
  });

  it("AGENTS.md's folder map names exactly the non-test .ts files directly in src/", () => {
    const block = AGENTS.match(/## Folder map[\s\S]*?```\n([\s\S]*?)```/)?.[1] ?? "";
    const mapped = [...block.matchAll(/^ {3}[├└]─ ([\w.-]+\.ts)\s/gm)].map((m) => m[1] as string);
    expect(mapped).toContain("server.ts");
    const actual = readdirSync(join(ROOT, "src"), { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(".ts") && !e.name.endsWith(".test.ts"))
      .map((e) => e.name);
    expect(mapped.sort(), "AGENTS.md's folder map and src/*.ts disagree").toEqual(actual.sort());
  });
});
