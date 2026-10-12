import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import type { PageExtractor } from "../core/extract.js";
import { CHILD_ENTRY, createChildExtractor } from "./extract-runner.js";

const fixture = (name: string) => new URL(`./fixtures/${name}`, import.meta.url);
const URL0 = "https://example.com/post";
const PAGE = `<!doctype html><html><head><title>Hi</title><meta property='og:image' content='/i.png'></head><body><article><h1>Quokkas</h1><p>${"Quokkas live on Rottnest island and are very friendly to visitors. ".repeat(20)}</p></article></body></html>`;
const SLOW_TEXT = `<title>Parsed fast</title><body>${"<div>".repeat(190)}<p>${"word ".repeat(200_000)}</p>${"</div>".repeat(190)}`;
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
});

describe("child extractor: a hostile page", () => {
  it("is killed at the deadline, the loop keeps ticking, and the child is gone", async () => {
    const pids: number[] = [];
    const extractor = make({ deadlineMs: 1500, onSpawn: (pid) => pids.push(pid) });
    let ticks = 0;
    const timer = setInterval(() => ticks++, 20);
    const started = performance.now();
    const out = await extractor.extract(DIV400K, URL0);
    const elapsed = performance.now() - started;
    clearInterval(timer);
    expect(out.kind).toBe("timeout");
    expect(elapsed).toBeGreaterThan(1400);
    expect(elapsed).toBeLessThan(6000);
    expect(ticks).toBeGreaterThan(30);
    expect(pids).toHaveLength(1);
    expect(alive(pids[0] as number)).toBe(false);
  }, 20_000);

  it("keeps the metadata posted before the deadline kill", async () => {
    const out = await make({ deadlineMs: 800, childEntry: fixture("child-hang.mjs") }).extract(
      PAGE,
      URL0,
    );
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
    const extractor = make({
      deadlineMs: 400,
      childEntry: fixture("child-hang.mjs"),
      onSpawn: (pid) => {
        // The first child must be fully gone before the second starts.
        if (pids.length === 1) expect(alive(pids[0] as number)).toBe(false);
        pids.push(pid);
      },
    });
    const both = await Promise.all([extractor.extract(PAGE, URL0), extractor.extract(PAGE, URL0)]);
    expect(both.map((o) => o.kind)).toEqual(["timeout", "timeout"]);
    expect(pids).toHaveLength(2);
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
