import type { OwnerId } from "./types.js";

/** A build's zip file: written in order, then renamed over the owner's export, or deleted. Structurally a `ZipSink`. */
export type ExportFileWriter = {
  write(bytes: Uint8Array): Promise<void>;
  /** fsync, close, rename over the owner's export; answers its size in bytes. */
  commit(): Promise<number>;
  /** Close and delete the temporary file; never throws. */
  discard(): Promise<void>;
};
export type ExportDownload = { size: number; body: ReadableStream<Uint8Array> };
/** The owner's export files. Owner-scoped by file name; implemented by `src/store/export-folder.ts`. */
export interface ExportFiles {
  create(owner: OwnerId): Promise<ExportFileWriter>;
  /** The owner's finished export, open for reading; null when there is none. */
  open(owner: OwnerId): Promise<ExportDownload | null>;
  remove(owner: OwnerId): Promise<void>;
}
export type StopFlag = { readonly stopped: boolean };
export class ExportStopped extends Error {
  constructor() {
    super("stopped");
  }
}
export type ExportSummary = { exportedAt: Date; links: number; files: number };
/** What "Your data" shows. */
export type ExportView =
  | { state: "idle" }
  | { state: "preparing"; startedAt: Date }
  | { state: "ready"; exportedAt: Date; bytes: number }
  | { state: "failed"; at: Date };
