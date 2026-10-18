import { execFileSync, fork } from "node:child_process";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PageExtractor } from "../core/extract.js";
import { isCopyDraft } from "../core/saved-copy.js";
import { CHILD_ENTRY, createChildExtractor } from "./extract-runner.js";

const fixture = (name: string) => new URL(`./fixtures/${name}`, import.meta.url);
const URL0 = "https://example.com/post";
const PAGE = `<!doctype html><html><head><title>Hi</title><meta property='og:image' content='/i.png'></head><body><article><h1>Quokkas</h1><p>${"Quokkas live on Rottnest island and are very friendly to visitors. ".repeat(20)}</p></article></body></html>`;
const SLOW_TEXT = `<title>Parsed fast</title><body>${"<div>".repeat(190)}<p>${"word ".repeat(200_000)}</p>${"</div>".repeat(190)}`;
// Child start-up counts against the deadline, and a child that has not yet received the page when
// it fires is reported `spawn_failed`, not `timeout`. Idle start-up is 40-80 ms; this leaves room
// for a machine under heavy load.
const DEADLINE_MS = 2000;
const ARTICLE_PAGE = readFileSync(fixture("nodejs-22-announcement.html"), "utf8");
const DIV400K = `<title>Hostile</title><body>${"<div>".repeat(400_000)}`;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
const pgidOf = (pid: number) =>
  execFileSync("ps", ["-o", "pgid=", "-p", String(pid)])
    .toString()
    .trim();

const open: PageExtractor[] = [];
function make(...args: Parameters<typeof createChildExtractor>) {
  const extractor = createChildExtractor({ onStderr: () => {}, ...args[0] });
  open.push(extractor);
  return extractor;
}
afterEach(async () => {
  await Promise.all(open.splice(0).map((e) => e.close()));
});

describe("child extractor: the real extraction code, as the child loads it", () => {
  // Fails if a file in the child's import closure imports a `.js` name or uses syntax that
  // Node's type stripping cannot erase: the child would then crash instead of extracting.
  it("extracts a page in a real child process", async () => {
    const pids: number[] = [];
    const out = await make({ onSpawn: (pid) => pids.push(pid) }).extract(PAGE, URL0);
    expect(out).toMatchObject({
      kind: "ok",
      metadata: { title: "Hi", imageUrl: "https://example.com/i.png" },
    });
    expect(out.kind === "ok" && out.text).toContain("Rottnest");
    expect(CHILD_ENTRY.pathname).toMatch(/\/src\/fetch\/extract-child\.ts$/);
    expect(alive(pids[0] as number)).toBe(false);
  }, 30_000);

  it("finishes its page when SIGINT arrives during the text step", async () => {
    const child = fork(CHILD_ENTRY, {
      serialization: "advanced",
      env: {},
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    try {
      const got: string[] = [];
      const ended = new Promise<{ code: number | null; signal: string | null }>((resolve) =>
        child.on("exit", (code, signal) => resolve({ code, signal })),
      );
      child.on("message", (m: { type: string }) => {
        got.push(m.type);
        if (m.type === "metadata") child.kill("SIGINT");
      });
      const page = `<title>T</title><body>${"<div>".repeat(190)}<p>${"word ".repeat(20_000)}</p>`;
      child.send({ html: page, finalUrl: URL0 });
      expect(await ended).toEqual({ code: 0, signal: null });
      expect(got).toEqual(["received", "metadata", "text"]);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  }, 30_000);
});

describe("child extractor: a hostile page", () => {
  it("is killed at the deadline, the loop keeps ticking, and the child is gone", async () => {
    const pids: number[] = [];
    const extractor = make({ deadlineMs: DEADLINE_MS, onSpawn: (pid) => pids.push(pid) });
    let ticks = 0;
    const timer = setInterval(() => ticks++, 20);
    const started = performance.now();
    const out = await extractor.extract(DIV400K, URL0);
    const elapsed = performance.now() - started;
    clearInterval(timer);
    expect(out.kind).toBe("timeout");
    expect(elapsed).toBeGreaterThan(DEADLINE_MS - 50);
    expect(elapsed).toBeLessThan(DEADLINE_MS + 4500);
    expect(ticks).toBeGreaterThan(30);
    expect(pids).toHaveLength(1);
    expect(alive(pids[0] as number)).toBe(false);
  }, 20_000);

  it("keeps the metadata posted before the deadline kill", async () => {
    const out = await make({
      deadlineMs: DEADLINE_MS,
      childEntry: fixture("child-hang.mjs"),
    }).extract(PAGE, URL0);
    expect(out).toEqual({
      kind: "timeout",
      metadata: { title: "Posted first", description: null, imageUrl: null },
    });
  }, 20_000);

  it("keeps the metadata of a real child whose text step outlives the deadline", async () => {
    const out = await make({ deadlineMs: 3000 }).extract(SLOW_TEXT, URL0);
    expect(out).toMatchObject({ kind: "timeout", metadata: { title: "Parsed fast" } });
  }, 20_000);

  it("finds the heap-limit line even after 70 KB of earlier stderr", async () => {
    const out = await make({
      maxOldSpaceMb: 48,
      childEntry: fixture("child-oom-noisy.mjs"),
    }).extract(PAGE, URL0);
    expect(out.kind).toBe("out_of_memory");
  }, 30_000);

  it("forwards a crashing child's stderr to the sink", async () => {
    const chunks: string[] = [];
    await make({
      childEntry: fixture("child-throw.mjs"),
      onStderr: (chunk) => chunks.push(chunk.toString("utf8")),
    }).extract(PAGE, URL0);
    expect(chunks.join("")).toContain("Error");
  }, 20_000);

  it("reports out_of_memory when the child dies of heap exhaustion, and the parent lives on", async () => {
    const pids: number[] = [];
    const out = await make({
      maxOldSpaceMb: 48,
      childEntry: fixture("child-oom.mjs"),
      onSpawn: (pid) => pids.push(pid),
    }).extract(PAGE, URL0);
    expect(out).toEqual({ kind: "out_of_memory", metadata: null });
    expect(alive(pids[0] as number)).toBe(false);
    expect(alive(process.pid)).toBe(true);
  }, 30_000);

  it("reports crashed, not out_of_memory, for an abort that is not the heap limit", async () => {
    const out = await make({ childEntry: fixture("child-abort.mjs") }).extract(PAGE, URL0);
    expect(out).toMatchObject({ kind: "crashed", metadata: null });
  }, 20_000);

  it("reports crashed, with the cause, when the child throws", async () => {
    const out = await make({ childEntry: fixture("child-throw.mjs") }).extract(PAGE, URL0);
    expect(out).toMatchObject({ kind: "crashed" });
    expect(out.kind === "crashed" && out.detail).toContain("exit code 1");
  }, 20_000);
});

describe("child extractor: a child that ends before it has the page", () => {
  it("reports spawn_failed when the child throws while loading", async () => {
    const out = await make({ childEntry: fixture("child-load-throw.mjs") }).extract(PAGE, URL0);
    expect(out.kind).toBe("spawn_failed");
    expect(out.kind === "spawn_failed" && out.detail).toContain("before receiving the page");
  }, 20_000);

  it("reports spawn_failed when the deadline fires before the child has the page", async () => {
    const out = await make({ deadlineMs: 500, childEntry: fixture("child-silent.mjs") }).extract(
      PAGE,
      URL0,
    );
    expect(out.kind).toBe("spawn_failed");
    expect(out.kind === "spawn_failed" && out.detail).toContain("before receiving the page");
  }, 20_000);

  it("still reports crashed for a child that received the page and then threw", async () => {
    const out = await make({ childEntry: fixture("child-throw.mjs") }).extract(PAGE, URL0);
    expect(out.kind).toBe("crashed");
  }, 20_000);

  it("still reports timeout for a child that received the page and then hung", async () => {
    const out = await make({
      deadlineMs: DEADLINE_MS,
      childEntry: fixture("child-hang.mjs"),
    }).extract(PAGE, URL0);
    expect(out.kind).toBe("timeout");
  }, 20_000);
});

describe("child extractor: process management", () => {
  it("runs the child in the service's own process group", async () => {
    const groups: string[] = [];
    await make({
      deadlineMs: 300,
      childEntry: fixture("child-hang.mjs"),
      onSpawn: (pid) => groups.push(pgidOf(pid)),
    }).extract(PAGE, URL0);
    expect(groups).toEqual([pgidOf(process.pid)]);
  }, 20_000);

  it("runs one extraction at a time", async () => {
    const pids: number[] = [];
    const earlierAliveAtSpawn: boolean[] = [];
    const extractor = make({
      deadlineMs: DEADLINE_MS,
      childEntry: fixture("child-hang.mjs"),
      // Only collect here: a throw in the hook would be swallowed, and so would the check.
      onSpawn: (pid) => {
        earlierAliveAtSpawn.push(pids.some(alive));
        pids.push(pid);
      },
    });
    const both = await Promise.all([extractor.extract(PAGE, URL0), extractor.extract(PAGE, URL0)]);
    expect(both.map((o) => o.kind)).toEqual(["timeout", "timeout"]);
    expect(pids).toHaveLength(2);
    // The first child must be fully gone before the second starts.
    expect(earlierAliveAtSpawn).toEqual([false, false]);
  }, 20_000);

  it("is not stopped by an onSpawn that throws: that and the next extraction still resolve", async () => {
    const extractor = make({
      onSpawn: () => {
        throw new Error("hook failed");
      },
    });
    const first = await extractor.extract(PAGE, URL0);
    const second = await extractor.extract(PAGE, URL0);
    expect([first.kind, second.kind]).toEqual(["ok", "ok"]);
  }, 30_000);

  it("raises no uncaught exception when onStderr throws", async () => {
    const uncaught: unknown[] = [];
    const listener = (err: unknown) => uncaught.push(err);
    process.on("uncaughtException", listener);
    try {
      const out = await make({
        childEntry: fixture("child-throw.mjs"),
        onStderr: () => {
          throw new Error("sink failed");
        },
      }).extract(PAGE, URL0);
      await new Promise((r) => setTimeout(r, 50));
      expect(out.kind).toBe("crashed");
      expect(uncaught).toEqual([]);
    } finally {
      process.off("uncaughtException", listener);
    }
  }, 20_000);

  it("leaves no timer behind when the child ends on its own before the disconnect grace passes", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const out = await make({ childEntry: fixture("child-throw.mjs") }).extract(PAGE, URL0);
      expect(out.kind).toBe("crashed");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  }, 20_000);

  it("reports spawn_failed, a retryable kind, when the child cannot start", async () => {
    const out = await make({ execPath: "/nonexistent/node" }).extract(PAGE, URL0);
    expect(out.kind).toBe("spawn_failed");
  }, 20_000);

  it("kills a child that drops its channel but stays alive, and reports spawn_failed", async () => {
    const pids: number[] = [];
    const started = performance.now();
    const out = await make({
      deadlineMs: 15_000,
      childEntry: fixture("child-disconnect.mjs"),
      onSpawn: (pid) => pids.push(pid),
    }).extract(PAGE, URL0);
    expect(out.kind).toBe("spawn_failed");
    expect(performance.now() - started).toBeLessThan(5000);
    expect(alive(pids[0] as number)).toBe(false);
  }, 20_000);

  it("kills the child and reports aborted when the caller's signal fires", async () => {
    const pids: number[] = [];
    const controller = new AbortController();
    const extractor = make({
      deadlineMs: 15_000,
      childEntry: fixture("child-hang.mjs"),
      onSpawn: (pid) => pids.push(pid),
    });
    setTimeout(() => controller.abort(), 400);
    const out = await extractor.extract(PAGE, URL0, controller.signal);
    expect(out).toEqual({ kind: "aborted" });
    expect(alive(pids[0] as number)).toBe(false);
  }, 20_000);

  it("starts no child for a signal that already fired", async () => {
    const pids: number[] = [];
    const out = await make({ onSpawn: (pid) => pids.push(pid) }).extract(
      PAGE,
      URL0,
      AbortSignal.abort(),
    );
    expect(out).toEqual({ kind: "aborted" });
    expect(pids).toEqual([]);
  });

  it("close() kills a running child, reports aborted, and refuses later work", async () => {
    const pids: number[] = [];
    const extractor = make({
      deadlineMs: 15_000,
      childEntry: fixture("child-hang.mjs"),
      onSpawn: (pid) => pids.push(pid),
    });
    const running = extractor.extract(PAGE, URL0);
    const queued = extractor.extract(PAGE, URL0);
    await new Promise((r) => setTimeout(r, 400));
    await extractor.close();
    expect(await running).toEqual({ kind: "aborted" });
    expect(await queued).toEqual({ kind: "aborted" });
    expect(alive(pids[0] as number)).toBe(false);
    expect(await extractor.extract(PAGE, URL0)).toEqual({ kind: "aborted" });
    expect(pids).toHaveLength(1);
  }, 20_000);
});

describe("child extractor: the saved copy", () => {
  const median = (xs: number[]) =>
    [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] as number;

  it("sends a copy that isCopyDraft accepts when asked", async () => {
    const out = await make().extract(ARTICLE_PAGE, "https://nodejs.org/en/blog/x", undefined, {
      copy: true,
    });
    expect(out.kind).toBe("ok");
    const copy = out.kind === "ok" ? out.copy : undefined;
    expect(isCopyDraft(copy)).toBe(true);
    expect(copy?.markdown).toMatch(/^#+ /m);
  }, 30_000);

  it("sends no copy key, and only received, metadata, text, when not asked", async () => {
    const out = await make().extract(ARTICLE_PAGE, URL0);
    expect(out.kind).toBe("ok");
    expect("copy" in out).toBe(false);
    const child = fork(CHILD_ENTRY, {
      serialization: "advanced",
      env: {},
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    const got: string[] = [];
    const ended = new Promise((resolve) => child.on("exit", resolve));
    child.on("message", (m: { type: string }) => got.push(m.type));
    child.send({ html: PAGE, finalUrl: URL0 });
    await ended;
    expect(got).toEqual(["received", "metadata", "text"]);
  }, 30_000);

  it("gives copy null for a page with no article", async () => {
    const out = await make().extract("<title>T</title><body></body>", URL0, undefined, {
      copy: true,
    });
    expect(out).toMatchObject({ kind: "ok", text: null, copy: null });
  }, 30_000);

  it("is ok without a copy when the caller aborts after the text", async () => {
    const controller = new AbortController();
    const out = await make({
      deadlineMs: 15_000,
      childEntry: fixture("child-copy-hang.mjs"),
      onStderr: (c) => c.toString().includes("text-sent") && controller.abort(),
    }).extract(PAGE, URL0, controller.signal, { copy: true });
    expect(out).toMatchObject({ kind: "ok", text: "Kept text" });
    expect("copy" in out).toBe(false);
  }, 20_000);

  it("is ok without a copy when the deadline passes after the text", async () => {
    const out = await make({
      deadlineMs: 500,
      childEntry: fixture("child-copy-hang.mjs"),
    }).extract(PAGE, URL0, undefined, { copy: true });
    expect(out).toMatchObject({ kind: "ok", text: "Kept text" });
    expect("copy" in out).toBe(false);
  }, 20_000);

  it("is ok without a copy when close() comes after the text, and later work is aborted", async () => {
    const extractor: PageExtractor = make({
      deadlineMs: 15_000,
      childEntry: fixture("child-copy-hang.mjs"),
      onStderr: (c) => c.toString().includes("text-sent") && void extractor.close(),
    });
    const out = await extractor.extract(PAGE, URL0, undefined, { copy: true });
    expect(out).toMatchObject({ kind: "ok", text: "Kept text" });
    expect("copy" in out).toBe(false);
    expect(await extractor.extract(PAGE, URL0)).toEqual({ kind: "aborted" });
  }, 20_000);

  it("drops a copy with a bad shape and stays ok", async () => {
    const out = await make({ childEntry: fixture("child-copy-bad.mjs") }).extract(
      PAGE,
      URL0,
      undefined,
      { copy: true },
    );
    expect(out).toMatchObject({ kind: "ok", text: "Kept text" });
    expect("copy" in out).toBe(false);
  }, 20_000);

  it("adds less than 2 s to a save (median of three, alternating)", async () => {
    const extractor = make();
    const times = { off: [] as number[], on: [] as number[] };
    for (let i = 0; i < 3; i++) {
      for (const copy of [false, true]) {
        const t0 = performance.now();
        const out = await extractor.extract(ARTICLE_PAGE, URL0, undefined, { copy });
        expect(out.kind).toBe("ok");
        times[copy ? "on" : "off"].push(performance.now() - t0);
      }
    }
    expect(median(times.on) - median(times.off)).toBeLessThan(2000);
  }, 120_000);
});
