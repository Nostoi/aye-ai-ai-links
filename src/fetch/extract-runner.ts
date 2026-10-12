import { type ChildProcess, fork } from "node:child_process";
import type { ExtractOutcome, PageExtractor, PageMetadata } from "../core/extract.js";

// Node runs the child from src/ under test and from dist/ in production.
export const CHILD_ENTRY = new URL(
  `./extract-child${import.meta.url.endsWith(".ts") ? ".ts" : ".js"}`,
  import.meta.url,
);

export type ChildExtractorOptions = {
  /** Time from spawn to SIGKILL. */
  deadlineMs?: number;
  maxOldSpaceMb?: number;
  childEntry?: URL;
  execPath?: string;
  /** Called with the child's pid right after it is spawned. */
  onSpawn?: (pid: number) => void;
  /** Receives each chunk the child writes to stderr. Defaults to this process's stderr. */
  onStderr?: (chunk: Buffer) => void;
};

type EndedBy = "deadline" | "abort" | "ipc";
// V8's fatal-error line: "Reached heap limit Allocation failed - JavaScript heap out of memory".
const HEAP_OOM = "heap out of memory";
const DISCONNECT_GRACE_MS = 500;
const STDERR_KEPT = 64 * 1024;

/**
 * Extracts in a forked child with its own heap limit, one page at a time.
 *
 * The child is not detached, so it stays in the service's process group and launchd's
 * kill-the-group at job death takes it too. Nothing the page does can reach this process
 * beyond the messages the child sends.
 */
export function createChildExtractor(options: ChildExtractorOptions = {}): PageExtractor {
  const {
    deadlineMs = 20_000,
    maxOldSpaceMb = 384,
    childEntry = CHILD_ENTRY,
    execPath = process.execPath,
    onSpawn,
    onStderr = (chunk) => process.stderr.write(chunk),
  } = options;
  let closed = false;
  let tail: Promise<unknown> = Promise.resolve();
  const killers = new Set<() => void>();

  function runOne(html: string, finalUrl: string, signal?: AbortSignal): Promise<ExtractOutcome> {
    if (closed || signal?.aborted) return Promise.resolve({ kind: "aborted" });
    return new Promise((resolve) => {
      let metadata: PageMetadata | null = null;
      let text: string | null | undefined;
      let endedBy: EndedBy | undefined;
      let stderr = "";
      let settled = false;
      let child: ChildProcess | undefined;
      const stop = (by: EndedBy) => {
        endedBy ??= by;
        child?.kill("SIGKILL");
      };
      const timer = setTimeout(() => stop("deadline"), deadlineMs);
      const onAbort = () => stop("abort");
      const settle = (outcome: ExtractOutcome) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        killers.delete(onAbort);
        resolve(outcome);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      killers.add(onAbort);

      try {
        child = fork(childEntry, {
          execPath,
          execArgv: [`--max-old-space-size=${maxOldSpaceMb}`],
          serialization: "advanced",
          env: {},
          stdio: ["ignore", "inherit", "pipe", "ipc"],
        });
      } catch (err) {
        return settle({ kind: "spawn_failed", detail: errorText(err) });
      }
      const spawned = child;
      if (spawned.pid !== undefined) onSpawn?.(spawned.pid);
      spawned.stderr?.on("data", (chunk: Buffer) => {
        onStderr(chunk);
        stderr = (stderr + chunk.toString("utf8")).slice(-STDERR_KEPT);
      });
      spawned.on(
        "message",
        (m: { type?: string; metadata?: PageMetadata; text?: string | null }) => {
          if (m.type === "metadata" && m.metadata) metadata = m.metadata;
          if (m.type === "text") text = m.text ?? null;
        },
      );
      spawned.on("disconnect", () => {
        if (text === undefined) setTimeout(() => settled || stop("ipc"), DISCONNECT_GRACE_MS);
      });
      spawned.on("error", (err) => {
        // A child that never got a pid never ran, so nothing will exit: settle here.
        if (spawned.pid === undefined) settle({ kind: "spawn_failed", detail: errorText(err) });
        else stop("ipc");
      });
      spawned.on("close", (code, sig) => {
        if (endedBy === "abort") return settle({ kind: "aborted" });
        if (text !== undefined && metadata) return settle({ kind: "ok", metadata, text });
        if (endedBy === "deadline") return settle({ kind: "timeout", metadata });
        if (endedBy === "ipc")
          return settle({ kind: "spawn_failed", detail: "child channel failed" });
        if (stderr.includes(HEAP_OOM)) return settle({ kind: "out_of_memory", metadata });
        const detail = sig ? `signal ${sig}` : `exit code ${code}`;
        settle({ kind: "crashed", metadata, detail });
      });
      try {
        spawned.send({ html, finalUrl }, (err) => {
          if (err) stop("ipc");
        });
      } catch {
        // A child that failed to spawn reports through its 'error' event.
      }
    });
  }

  return {
    extract(html, finalUrl, signal) {
      const ahead = tail;
      const mine = ahead.then(() => runOne(html, finalUrl, signal));
      tail = mine;
      return mine;
    },
    async close() {
      closed = true;
      for (const kill of killers) kill();
      await tail;
    },
  };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
