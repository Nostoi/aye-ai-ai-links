import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { hashKey } from "../auth/agent-keys.js";
import { run } from "./keys.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function env(extra: Record<string, string> = {}): Record<string, string | undefined> {
  const dir = mkdtempSync(join(tmpdir(), "aye-cli-"));
  dirs.push(dir);
  return { AYE_DB: join(dir, "test.db"), ...extra };
}

function exec(argv: string[], vars: Record<string, string | undefined>) {
  const out: string[] = [];
  const err: string[] = [];
  const code = run(
    argv,
    vars,
    (s) => out.push(s),
    (s) => err.push(s),
  );
  return { code, out: out.join("\n"), err: err.join("\n") };
}

describe("keys CLI", () => {
  it("refuses a missing AYE_DB and an in-memory one", () => {
    for (const vars of [
      {},
      { AYE_DB: "" },
      { AYE_DB: ":memory:" },
      { AYE_DB: "relative.db" },
      { AYE_DB: "~/links.db" },
    ]) {
      const r = exec(["list"], vars);
      expect(r.code).toBe(1);
      expect(r.err).toMatch(/AYE_DB/);
      expect(r.out).toBe("");
    }
  });

  it("creates a key, printing it once, then lists it without the key or its hash", () => {
    const vars = env();
    const created = exec(["create", "codex"], vars);
    expect(created.code).toBe(0);
    const key = /aak_[A-Za-z0-9_-]+/.exec(created.out)?.[0];
    expect(key).toBeDefined();

    const listed = exec(["list"], vars);
    expect(listed.code).toBe(0);
    expect(listed.out).toContain("codex");
    expect(listed.out).not.toContain(key as string);
    expect(listed.out).not.toContain(hashKey(key as string));
    expect(listed.out).not.toMatch(/aak_/);
  });

  it("refuses a second live key for the same agent with one line on stderr", () => {
    const vars = env();
    exec(["create", "codex"], vars);
    const again = exec(["create", "codex"], vars);
    expect(again.code).toBe(1);
    expect(again.err).toMatch(/already has a live key/);
    expect(again.err.split("\n")).toHaveLength(1);
    expect(again.out).toBe("");
  });

  it("revokes a key, saying it is turned off, then lists it turned off and allows a new one", () => {
    const vars = env();
    exec(["create", "codex"], vars);
    const revoked = exec(["revoke", "codex"], vars);
    expect(revoked.code).toBe(0);
    expect(revoked.out).toBe("Turned off the key for codex.");
    expect(exec(["list"], vars).out).toMatch(/\tturned off \d{4}-/);
    expect(exec(["create", "codex"], vars).code).toBe(0);
  });

  it.each([
    ["a name over 60 characters", "a".repeat(61), /60 characters/],
    ["the name web", "Web", /"web"/],
    ["a name with a tab", "codex\tlaptop", /printable/],
    ["a name with a line break", "codex\nlaptop", /printable/],
    ["a name with a lone surrogate", "\ud800codex", /printable/],
  ])("refuses %s, making no key", (_, agent, message) => {
    const vars = env();
    const r = exec(["create", agent], vars);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(message);
    expect(r.out).toBe("");
    expect(exec(["list"], vars).out).toBe("");
  });

  it("revoking an unknown agent is a clear error", () => {
    const r = exec(["revoke", "nobody"], env());
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/nobody/);
  });

  it("keeps owners apart through AYE_OWNER", () => {
    const vars = env({ AYE_OWNER: "mark" });
    exec(["create", "codex"], vars);
    expect(exec(["list"], { ...vars, AYE_OWNER: "alice" }).out).not.toContain("codex");
    expect(exec(["revoke", "codex"], { ...vars, AYE_OWNER: "alice" }).code).toBe(1);
  });

  it("prints usage and exits 1 for a missing or unknown command or missing agent", () => {
    const vars = env();
    for (const argv of [[], ["frobnicate"], ["create"], ["revoke"]]) {
      const r = exec(argv, vars);
      expect(r.code, argv.join(" ")).toBe(1);
      expect(r.err).toMatch(/Usage/);
    }
  });

  describe("as a script", () => {
    const root = resolve(import.meta.dirname, "../..");

    beforeAll(() => {
      execFileSync("npm", ["run", "build"], { cwd: root, stdio: "pipe" });
    }, 60_000);

    it("runs when started through a symlinked path", () => {
      const dir = mkdtempSync(join(tmpdir(), "aye-link-"));
      dirs.push(dir);
      symlinkSync(join(root, "dist"), join(dir, "dist"));
      const stdout = execFileSync("node", [join(dir, "dist/cli/keys-main.js"), "create", "codex"], {
        env: { ...process.env, AYE_DB: join(dir, "test.db") },
        encoding: "utf8",
      });
      expect(stdout).toMatch(/^aak_[A-Za-z0-9_-]+\n$/);
    });

    it("does nothing, without crashing, when imported by a process whose argv[1] is not a file", () => {
      const target = pathToFileURL(join(root, "dist/cli/keys.js")).href;
      const result = spawnSync("node", ["-"], {
        input: `await import(${JSON.stringify(target)});`,
        encoding: "utf8",
      });
      expect(result.stderr).not.toMatch(/ENOENT/);
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("");
    });
  });
});
