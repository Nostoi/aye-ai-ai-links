import {
  type ExportDownload,
  type ExportFiles,
  type ExportFileWriter,
  ExportStopped,
  type ExportSummary,
  type ExportView,
  type StopFlag,
} from "./export-types.js";
import type { OwnerId } from "./types.js";

/** How long a finished export stays downloadable, counted from its `exportedAt`. */
export const EXPORT_KEEP_MS = 24 * 3600_000;

export type ExportBuilds = {
  view(owner: OwnerId): ExportView;
  start(owner: OwnerId): "started" | "already_preparing";
  /** The owner's unexpired export, whatever the current state; null when none. */
  download(owner: OwnerId): Promise<(ExportDownload & { exportedAt: Date }) | null>;
  /** Resolves when the owner's current build has ended. Never rejects. */
  settled(owner: OwnerId): Promise<void>;
  /** Tell running builds to stop, and cancel every expiry timer. */
  stop(): void;
};

type Ready = { exportedAt: Date; bytes: number };
type Entry = {
  state: ExportView;
  ready: Ready | null;
  timer?: NodeJS.Timeout;
  running?: Promise<void>;
};

/** A reason safe to log: never the message, which can hold a path or URL. */
function reason(error: unknown): string {
  if (error instanceof ExportStopped) return "stopped";
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string") return code;
  return error instanceof Error ? error.name : "error";
}

export function createExportBuilds(o: {
  build: (owner: OwnerId, sink: ExportFileWriter, stop: StopFlag) => Promise<ExportSummary>;
  files: ExportFiles;
  now: () => Date;
  keepMs?: number;
  log?: (line: string) => void;
}): ExportBuilds {
  const keepMs = o.keepMs ?? EXPORT_KEEP_MS;
  const log = o.log ?? (() => {});
  const entries = new Map<OwnerId, Entry>();
  const flag = { stopped: false };

  const entryOf = (owner: OwnerId): Entry => {
    let e = entries.get(owner);
    if (!e) {
      e = { state: { state: "idle" }, ready: null };
      entries.set(owner, e);
    }
    return e;
  };
  const expiresAt = (r: Ready) => r.exportedAt.getTime() + keepMs;
  const expired = (r: Ready) => o.now().getTime() >= expiresAt(r);

  const removeFile = (owner: OwnerId) => {
    void o.files.remove(owner).catch((error) => log(`[export] remove failed: ${reason(error)}`));
  };

  /** Drop the owner's ready file: the timer or a refused download. Leaves a build in progress alone. */
  const expire = (owner: OwnerId, e: Entry) => {
    clearTimeout(e.timer);
    e.timer = undefined;
    e.ready = null;
    if (e.state.state === "ready") e.state = { state: "idle" };
    removeFile(owner);
  };

  const setReady = (owner: OwnerId, e: Entry, ready: Ready) => {
    clearTimeout(e.timer);
    e.ready = ready;
    e.state = { state: "ready", ...ready };
    const timer = setTimeout(
      () => expire(owner, e),
      Math.max(0, expiresAt(ready) - o.now().getTime()),
    );
    timer.unref();
    e.timer = timer;
  };

  const run = async (owner: OwnerId, e: Entry, startedAt: Date): Promise<void> => {
    let file: ExportFileWriter | undefined;
    try {
      file = await o.files.create(owner);
      const summary = await o.build(owner, file, flag);
      if (flag.stopped) throw new ExportStopped();
      const bytes = await file.commit();
      setReady(owner, e, { exportedAt: summary.exportedAt, bytes });
      const ms = Math.max(0, o.now().getTime() - startedAt.getTime());
      log(
        `[export] ready: ${summary.links} links, ${summary.files} files, ${bytes} bytes, ${ms}ms`,
      );
    } catch (error) {
      await file?.discard().catch(() => {});
      e.state = { state: "failed", at: o.now() };
      log(`[export] failed: ${reason(error)}`);
    }
  };

  return {
    view(owner) {
      const e = entries.get(owner);
      if (!e) return { state: "idle" };
      if (e.state.state === "ready" && e.ready && expired(e.ready)) return { state: "idle" };
      return e.state;
    },
    start(owner) {
      const e = entryOf(owner);
      if (e.state.state === "preparing") return "already_preparing";
      const at = o.now();
      if (flag.stopped) {
        e.state = { state: "failed", at };
        log("[export] failed: stopped");
        return "started";
      }
      e.state = { state: "preparing", startedAt: at };
      e.running = run(owner, e, at);
      return "started";
    },
    async download(owner) {
      const e = entries.get(owner);
      if (!e?.ready) return null;
      const { exportedAt } = e.ready;
      if (expired(e.ready)) {
        expire(owner, e);
        return null;
      }
      const file = await o.files.open(owner);
      return file ? { ...file, exportedAt } : null;
    },
    settled(owner) {
      return entries.get(owner)?.running ?? Promise.resolve();
    },
    stop() {
      flag.stopped = true;
      for (const e of entries.values()) {
        clearTimeout(e.timer);
        e.timer = undefined;
      }
    },
  };
}
