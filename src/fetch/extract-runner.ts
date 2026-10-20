import { type ChildProcess, fork } from "node:child_process";
import type { ExtractOutcome, PageExtractor, PageMetadata } from "../core/extract.js";
import { type CopyDraft, isCopyDraft } from "../core/saved-copy.js";

// Node runs the child from src/ under test and from dist/ in production.
export const CHILD_ENTRY = new URL(
  `./extract-child${import.meta.url.endsWith(".ts") ? ".ts" : ".js"}`,
  import.meta.url,
);

/** Default time from spawn to SIGKILL. */
export const EXTRACT_DEADLINE_MS = 20_000;

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
    deadlineMs = EXTRACT_DEADLINE_MS,
    maxOldSpaceMb = 384,
    childEntry = CHILD_ENTRY,
    execPath = process.execPath,
    onSpawn,
    onStderr = (chunk) => process.stderr.write(chunk),
  } = options;
  let closed = false;
  let tail: Promise<unknown> = Promise.resolve();
  const killers = new Set<() => void>();

  function runOne(
    html: string,
    finalUrl: string,
    signal: AbortSignal | undefined,
    wantCopy: boolean,
  ): Promise<ExtractOutcome> {
    if (closed || signal?.aborted) return Promise.resolve({ kind: "aborted" });
    return new Promise((resolve) => {
      let metadata: PageMetadata | null = null;
      let text: string | null | undefined;
      let copy: CopyDraft | null | undefined;
      let endedBy: EndedBy | undefined;
      let received = false;
      let stderr = "";
      let settled = false;
      let child: ChildProcess | undefined;
      let graceTimer: NodeJS.Timeout | undefined;
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
        clearTimeout(graceTimer);
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
      // The hooks belong to the caller: a throw must not reject this call or end up uncaught.
      if (spawned.pid !== undefined) {
        try {
          onSpawn?.(spawned.pid);
        } catch {
          // Ignored.
        }
      }
      spawned.stderr?.on("data", (chunk: Buffer) => {
        try {
          onStderr(chunk);
        } catch {
          // Ignored.
        }
        stderr = (stderr + chunk.toString("utf8")).slice(-STDERR_KEPT);
      });
      spawned.on(
        "message",
        (m: { type?: string; metadata?: PageMetadata; text?: string | null; copy?: unknown }) => {
          if (m.type === "received") received = true;
          if (m.type === "metadata" && m.metadata) metadata = m.metadata;
          if (m.type === "text") text = m.text ?? null;
          if (m.type === "copy")
            copy = m.copy === null ? null : isCopyDraft(m.copy) ? m.copy : undefined;
        },
      );
      spawned.on("disconnect", () => {
        if (text === undefined && !settled) {
          graceTimer = setTimeout(() => settled || stop("ipc"), DISCONNECT_GRACE_MS);
        }
      });
      spawned.on("error", (err) => {
        // A child that never got a pid never ran, so nothing will exit: settle here.
        if (spawned.pid === undefined) settle({ kind: "spawn_failed", detail: errorText(err) });
        else stop("ipc");
      });
      spawned.on("close", (code, sig) => {
        // Metadata and text in hand: any end, an abort or a lost channel included, is ok.
        if (text !== undefined && metadata) {
          return settle({ kind: "ok", metadata, text, ...(copy !== undefined && { copy }) });
        }
        if (endedBy === "abort") return settle({ kind: "aborted" });
        if (!received) {
          // The page was never parsed, so this is the machine's fault, not the content's.
          const cause =
            endedBy === "deadline"
              ? "deadline passed"
              : endedBy === "ipc"
                ? "channel failed"
                : sig
                  ? `signal ${sig}`
                  : `exit code ${code}`;
          return settle({
            kind: "spawn_failed",
            detail: `child ended before receiving the page: ${cause}`,
          });
        }
        if (endedBy === "deadline") return settle({ kind: "timeout", metadata });
        if (endedBy === "ipc")
          return settle({ kind: "spawn_failed", detail: "child channel failed" });
        if (stderr.includes(HEAP_OOM)) return settle({ kind: "out_of_memory", metadata });
        const detail = sig ? `signal ${sig}` : `exit code ${code}`;
        settle({ kind: "crashed", metadata, detail });
      });
      try {
        spawned.send({ html, finalUrl, copy: wantCopy }, (err) => {
          if (err) stop("ipc");
        });
      } catch {
        // A child that failed to spawn reports through its 'error' event.
      }
    });
  }

  return {
    extract(html, finalUrl, signal, options) {
      const ahead = tail;
      const mine = ahead.then(() => runOne(html, finalUrl, signal, options?.copy === true));
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
