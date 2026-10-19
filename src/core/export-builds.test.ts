import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createExportBuilds, EXPORT_KEEP_MS } from "./export-builds.js";
import {
  type ExportDownload,
  type ExportFiles,
  type ExportFileWriter,
  ExportStopped,
  type ExportSummary,
  type StopFlag,
} from "./export-types.js";

const A = "owner-a";
const B = "owner-b";
const T0 = new Date("2026-10-19T08:00:00Z");
const HOUR = 3600_000;

type Call = {
  owner: string;
  stop: StopFlag;
  sink: ExportFileWriter;
  resolve: (s: ExportSummary) => void;
  reject: (e: unknown) => void;
};

function setup() {
  let t = new Date(T0);
  const fileCalls: string[] = [];
  const lines: string[] = [];
  const calls: Call[] = [];
  let commitError: Error | null = null;
  let buildThrows: Error | null = null;
  let openGate: Promise<void> | null = null;
  const files: ExportFiles = {
    async create(owner) {
      fileCalls.push(`create ${owner}`);
      return {
        async write() {},
        async commit() {
          if (commitError) throw commitError;
          fileCalls.push(`commit ${owner}`);
          return 42;
        },
        async discard() {
          fileCalls.push(`discard ${owner}`);
        },
      };
    },
    async open(owner) {
      fileCalls.push(`open ${owner}`);
      if (openGate) await openGate;
      return {
        size: 42,
        body: new ReadableStream({ cancel: () => void fileCalls.push(`cancel ${owner}`) }),
      } satisfies ExportDownload;
    },
    async remove(owner) {
      fileCalls.push(`remove ${owner}`);
    },
  };
  const builds = createExportBuilds({
    build: (owner, sink, stop) => {
      if (buildThrows) throw buildThrows;
      return new Promise<ExportSummary>((resolve, reject) => {
        calls.push({ owner, stop, sink, resolve, reject });
      });
    },
    files,
    now: () => t,
    log: (line) => lines.push(line),
  });
  const last = (owner: string) => {
    const c = [...calls].reverse().find((x) => x.owner === owner);
    if (!c) throw new Error("no build call");
    return c;
  };
  return {
    builds,
    lines,
    fileCalls,
    setNow: (d: Date) => {
      t = d;
    },
    buildCalls: () => calls.map((c) => c.owner),
    lastCall: last,
    finish: (owner: string, links = 3, filesCount = 5) =>
      last(owner).resolve({ exportedAt: t, links, files: filesCount }),
    fail: (owner: string, e: unknown) => last(owner).reject(e),
    holdOpen: () => {
      let release = () => {};
      openGate = new Promise<void>((r) => {
        release = r;
      });
      return () => {
        openGate = null;
        release();
      };
    },
    breakCommit: (e: Error) => {
      commitError = e;
    },
    breakBuild: (e: Error) => {
      buildThrows = e;
    },
    count: (prefix: string) => fileCalls.filter((c) => c.startsWith(prefix)).length,
  };
}

/** Let create() and the build call run: they follow a few microtasks. */
const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

/** Start a build for the owner and finish it at the current fake time. */
async function ready(b: ReturnType<typeof setup>, owner: string) {
  b.builds.start(owner);
  await flush();
  b.finish(owner);
  await b.builds.settled(owner);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("export builds", () => {
  it("keeps files for 24 hours", () => {
    expect(EXPORT_KEEP_MS).toBe(24 * HOUR);
  });

  it("one build per owner: a second start while preparing starts nothing; another owner can start", async () => {
    const b = setup();
    expect(b.builds.start(A)).toBe("started");
    expect(b.builds.start(A)).toBe("already_preparing");
    expect(b.builds.start(B)).toBe("started");
    await flush();
    expect(b.buildCalls()).toEqual([A, B]);
    b.finish(A);
    await b.builds.settled(A);
    expect(b.builds.view(A)).toEqual({ state: "ready", exportedAt: T0, bytes: 42 });
    expect(b.builds.view(B).state).toBe("preparing");
    expect(b.count("commit")).toBe(1);
  });

  it("a failed build discards its file, logs no message, and shows failed", async () => {
    const b = setup();
    b.builds.start(A);
    await flush();
    b.fail(A, new Error("boom https://ex.com /private/path"));
    await b.builds.settled(A);
    expect(b.fileCalls).toContain(`discard ${A}`);
    expect(b.count("commit")).toBe(0);
    expect(b.builds.view(A)).toEqual({ state: "failed", at: T0 });
    expect(b.lines).toEqual(["[export] failed: Error"]);
  });

  it("logs the error code when it has one", async () => {
    const b = setup();
    b.builds.start(A);
    await flush();
    b.fail(A, Object.assign(new Error("open /x/y"), { code: "ENOSPC" }));
    await b.builds.settled(A);
    expect(b.lines).toEqual(["[export] failed: ENOSPC"]);
  });

  it("the 24-hour timer deletes the file and returns to idle; Prepare again clears the old timer", async () => {
    const b = setup();
    await ready(b, A);
    vi.advanceTimersByTime(23 * HOUR);
    expect(b.count("remove")).toBe(0);
    b.setNow(new Date(T0.getTime() + 23 * HOUR));
    expect(b.builds.start(A)).toBe("started");
    await flush();
    b.finish(A);
    await b.builds.settled(A);
    vi.advanceTimersByTime(2 * HOUR); // the old timer would have fired at 24h
    expect(b.count("remove")).toBe(0);
    vi.advanceTimersByTime(22 * HOUR);
    expect(b.count("remove")).toBe(1);
    b.setNow(new Date(T0.getTime() + 47 * HOUR));
    expect(b.builds.view(A)).toEqual({ state: "idle" });
  });

  it("a file past 24 hours is refused and deleted by download, and view shows idle without I/O", async () => {
    const b = setup();
    await ready(b, A);
    b.setNow(new Date(T0.getTime() + EXPORT_KEEP_MS));
    expect(b.builds.view(A)).toEqual({ state: "idle" });
    expect(b.count("remove")).toBe(0);
    expect(await b.builds.download(A)).toBeNull();
    expect(b.count("open")).toBe(0);
    expect(b.count("remove")).toBe(1);
  });

  it("serves a ready file with its exportedAt, and null for an owner with none", async () => {
    const b = setup();
    expect(await b.builds.download(A)).toBeNull();
    await ready(b, A);
    const d = await b.builds.download(A);
    expect(d?.size).toBe(42);
    expect(d?.exportedAt).toEqual(T0);
    expect(await b.builds.download(B)).toBeNull();
    expect(b.fileCalls).not.toContain(`open ${B}`);
  });

  it("serves the previous file while a rebuild runs, and after a rebuild fails (R5)", async () => {
    const b = setup();
    await ready(b, A);
    b.builds.start(A);
    await flush();
    expect(b.builds.view(A).state).toBe("preparing");
    expect(await b.builds.download(A)).not.toBeNull();
    expect(b.count("open")).toBe(1);
    b.fail(A, new Error("x"));
    await b.builds.settled(A);
    expect(b.builds.view(A).state).toBe("failed");
    expect(await b.builds.download(A)).not.toBeNull();
    expect(b.count("open")).toBe(2);
  });

  it("the old file's expiry during a rebuild leaves preparing alone (R6)", async () => {
    const b = setup();
    await ready(b, A);
    b.builds.start(A);
    await flush();
    vi.advanceTimersByTime(EXPORT_KEEP_MS);
    b.setNow(new Date(T0.getTime() + EXPORT_KEEP_MS));
    expect(b.count("remove")).toBe(0); // the rebuild's rename may replace it
    expect(b.builds.view(A).state).toBe("preparing");
    expect(await b.builds.download(A)).toBeNull();
    expect(b.count("open")).toBe(0);
    b.finish(A);
    await b.builds.settled(A);
    expect(b.builds.view(A)).toMatchObject({ state: "ready" });
    expect(await b.builds.download(A)).not.toBeNull();
    expect(b.count("remove")).toBe(0);
  });

  it("the old file's expiry during a rebuild that fails deletes the old file once", async () => {
    const b = setup();
    await ready(b, A);
    b.builds.start(A);
    await flush();
    vi.advanceTimersByTime(EXPORT_KEEP_MS);
    expect(b.count("remove")).toBe(0);
    b.fail(A, new Error("x"));
    await b.builds.settled(A);
    expect(b.count("remove")).toBe(1);
    expect(b.builds.view(A).state).toBe("failed");
    b.builds.start(A);
    await flush();
    b.finish(A);
    await b.builds.settled(A);
    expect(b.count("remove")).toBe(1); // the flag was cleared
  });

  it("a download answers with the date of the bytes it opened, even if a rebuild commits meanwhile", async () => {
    const b = setup();
    await ready(b, A);
    const release = b.holdOpen();
    const pending = b.builds.download(A);
    await flush();
    const later = new Date(T0.getTime() + HOUR);
    b.setNow(later);
    b.builds.start(A);
    await flush();
    b.finish(A);
    await b.builds.settled(A);
    release();
    const d = await pending;
    expect(d?.exportedAt).toEqual(later);
    expect(b.count("cancel")).toBe(1);
    expect(b.count("open")).toBe(2);
  });

  it("stop() sets the flag the running build sees, clears timers, and a later start fails at once", async () => {
    const b = setup();
    await ready(b, B); // B holds an expiry timer
    b.builds.start(A);
    await flush();
    const call = b.lastCall(A);
    expect(call.stop.stopped).toBe(false);
    b.builds.stop();
    expect(call.stop.stopped).toBe(true);
    call.reject(new ExportStopped());
    await b.builds.settled(A);
    expect(b.builds.view(A).state).toBe("failed");
    expect(b.lines).toContain("[export] failed: stopped");
    expect(b.fileCalls).toContain(`discard ${A}`);
    vi.advanceTimersByTime(2 * EXPORT_KEEP_MS);
    expect(b.count("remove")).toBe(0);
    const before = b.buildCalls().length;
    expect(b.builds.start(A)).toBe("started");
    await flush();
    expect(b.builds.view(A).state).toBe("failed");
    expect(b.buildCalls()).toHaveLength(before);
    expect(b.count("create")).toBe(2);
  });

  it("a build that finishes after stop() is discarded, not committed or timed", async () => {
    const b = setup();
    b.builds.start(A);
    await flush();
    b.builds.stop();
    b.finish(A);
    await b.builds.settled(A);
    expect(b.count("commit")).toBe(0);
    expect(b.fileCalls).toContain(`discard ${A}`);
    expect(b.builds.view(A).state).toBe("failed");
    expect(b.lines).toEqual(["[export] failed: stopped"]);
  });

  it("logs ready with links, files, bytes and ms", async () => {
    const b = setup();
    b.builds.start(A);
    await flush();
    b.finish(A, 3, 5);
    await b.builds.settled(A);
    expect(b.lines).toHaveLength(1);
    expect(b.lines[0]).toMatch(/^\[export\] ready: 3 links, 5 files, 42 bytes, \d+ms$/);
  });

  it("a build that throws synchronously or a commit that rejects never escapes as an unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on("unhandledRejection", onUnhandled);
    try {
      const b = setup();
      b.breakBuild(new Error("sync"));
      b.builds.start(A);
      await b.builds.settled(A);
      expect(b.builds.view(A).state).toBe("failed");
      expect(b.fileCalls).toContain(`discard ${A}`);

      const c = setup();
      c.breakCommit(Object.assign(new Error("disk /p"), { code: "EIO" }));
      c.builds.start(A);
      await flush();
      c.finish(A);
      await c.builds.settled(A);
      expect(c.builds.view(A).state).toBe("failed");
      expect(c.fileCalls).toContain(`discard ${A}`);
      expect(c.lines).toEqual(["[export] failed: EIO"]);
      await new Promise<void>((r) => setImmediate(r));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("a failed remove on expiry is logged by code and does not escape", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on("unhandledRejection", onUnhandled);
    try {
      const files: ExportFiles = {
        create: async () => ({
          write: async () => {},
          commit: async () => 7,
          discard: async () => {},
        }),
        open: async () => null,
        remove: async () => {
          throw Object.assign(new Error("rm /x"), { code: "EPERM" });
        },
      };
      const lines: string[] = [];
      const builds = createExportBuilds({
        build: async () => ({ exportedAt: T0, links: 1, files: 1 }),
        files,
        now: () => T0,
        log: (l) => lines.push(l),
      });
      builds.start(A);
      await builds.settled(A);
      vi.advanceTimersByTime(EXPORT_KEEP_MS);
      await new Promise<void>((r) => setImmediate(r));
      expect(lines.at(-1)).toBe("[export] remove failed: EPERM");
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
