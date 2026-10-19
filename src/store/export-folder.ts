import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { chmod, lstat, mkdir, open, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { ExportDownload, ExportFiles, ExportFileWriter } from "../core/export-types.js";
import type { OwnerId } from "../core/types.js";

/** The only names a build makes: an owner's zip, or its temporary file. */
const BUILD_NAME = /^[0-9a-f]{32}\.zip(\.tmp-[0-9a-f]{16})?$/;

const code = (e: unknown) => (e as NodeJS.ErrnoException).code;

/**
 * The private folder of finished exports. Each owner's file is named by a hash of the owner id.
 * Files open with O_NOFOLLOW; a build writes a temporary file and renames it over the owner's
 * export, so a download already open keeps reading the old bytes.
 */
export class ExportFolder implements ExportFiles {
  constructor(private readonly dir: string | null) {}

  private base(): string {
    if (this.dir === null) throw new Error("no export folder");
    return this.dir;
  }

  private finalPath(owner: OwnerId): string {
    const hash = createHash("sha256").update(owner).digest("hex").slice(0, 32);
    return join(this.base(), `${hash}.zip`);
  }

  /** Makes the folder 0700 (refusing a symlink or non-directory) and deletes the names a build makes. */
  async reset(): Promise<void> {
    const dir = this.base();
    const st = await lstat(dir).catch((e) => {
      if (code(e) === "ENOENT") return null;
      throw e;
    });
    if (st && (st.isSymbolicLink() || !st.isDirectory()))
      throw new Error("Export folder is not a plain directory");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
    for (const name of await readdir(dir))
      if (BUILD_NAME.test(name)) await rm(join(dir, name), { force: true });
  }

  async create(owner: OwnerId): Promise<ExportFileWriter> {
    const final = this.finalPath(owner);
    const tmp = `${final}.tmp-${randomBytes(8).toString("hex")}`;
    const handle = await open(
      tmp,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    return writer(handle, tmp, final);
  }

  async open(owner: OwnerId): Promise<ExportDownload | null> {
    if (this.dir === null) return null;
    let handle: FileHandle;
    try {
      handle = await open(this.finalPath(owner), constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (e) {
      if (code(e) === "ENOENT") return null;
      throw e;
    }
    try {
      const { size } = await handle.stat();
      return {
        size,
        body: Readable.toWeb(handle.createReadStream()) as ReadableStream<Uint8Array>,
      };
    } catch (e) {
      await handle.close().catch(() => {});
      throw e;
    }
  }

  async remove(owner: OwnerId): Promise<void> {
    await rm(this.finalPath(owner), { force: true });
  }
}

const writer = (handle: FileHandle, tmp: string, final: string): ExportFileWriter => ({
  async write(bytes) {
    let off = 0;
    while (off < bytes.length) {
      const { bytesWritten } = await handle.write(bytes, off);
      off += bytesWritten;
    }
  },
  async commit() {
    await handle.sync();
    const { size } = await handle.stat();
    await handle.close();
    await rename(tmp, final);
    return size;
  },
  async discard() {
    await handle.close().catch(() => {});
    await rm(tmp, { force: true }).catch(() => {});
  },
});
