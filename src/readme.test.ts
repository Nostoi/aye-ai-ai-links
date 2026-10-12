import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import type { Caller } from "./auth/caller.js";
import { createDeps } from "./deps.js";
import { openDatabase } from "./store/database.js";

const ROOT = join(import.meta.dirname, "..");
const README = readFileSync(join(ROOT, "README.md"), "utf8");
const OWNER: Caller = { owner: "owner-a", savedBy: "claude-code" };

async function listedToolNames(): Promise<string[]> {
  const db = openDatabase(":memory:");
  try {
    const deps = createDeps(db);
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
});
