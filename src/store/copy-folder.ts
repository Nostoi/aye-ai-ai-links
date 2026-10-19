import { randomBytes } from "node:crypto";
import fs from "node:fs";
import { isAbsolute, join } from "node:path";
import { MAX_IMAGE_BYTES } from "../core/image-type.js";
import { MAX_COPY_MARKDOWN_BYTES } from "../core/saved-copy.js";

export const MARKER = ".aye-saved-copies";
export const TMP = ".aye-tmp";
/** Names a sync client or Finder adds to a folder that is otherwise empty. */
export const IGNORED_IN_EMPTY = new Set([".DS_Store", ".localized", "Icon\r", TMP]);
const LINK_DIR = /^[0-9]{1,20}$/;
const IMAGE_FILE = /^[0-9]{2}\.(png|jpg|gif|webp)$/;
const STAGE_DIR = /^tmp-[0-9a-f]{32}$/;
const STAGE_FILE = /^(tmp-[0-9a-f]{32}|write-check-[0-9]+)$/;

/** Thrown by a read whose file is over its cap, before its bytes are returned. */
export class CopyFileTooLarge extends Error {}
/** Thrown by an image write into a link folder that has no copy.md. */
export class CopyFolderMissing extends Error {}

/** Whether a name removeCopy left, relative to the link folder, is one the store makes. */
export const madeByStore = (name: string): boolean =>
  name === "copy.md" || (name.startsWith("images/") && IMAGE_FILE.test(name.slice(7)));

const refused = () => new Error("Refused saved-copy path");
const code = (e: unknown) => (e as NodeJS.ErrnoException).code;
const lstat = (p: string) => {
  try {
    return fs.lstatSync(p);
  } catch (e) {
    if (code(e) === "ENOENT") return null;
    throw e;
  }
};
const gone = (e: unknown) => ["ENOENT", "ENOTDIR", "ELOOP"].includes(code(e) ?? "");

/**
 * The saved-copies folder. Every path is built under the real root from validated names; symlinks
 * already present are refused (folders by lstat, files by O_NOFOLLOW), and only names the store
 * makes are ever deleted.
 */
export class CopyFolder {
  private real: string | null = null;

  constructor(private readonly root: string | null) {
    if (root !== null && !isAbsolute(root))
      throw new Error("Saved-copy folder must be an absolute path");
  }

  /** Creates the root if missing and returns its real path; throws on failure. */
  prepare(): void {
    if (this.root === null) throw new Error("No saved-copy folder is set");
    fs.mkdirSync(this.root, { recursive: true });
    const real = fs.realpathSync(this.root);
    if (!fs.statSync(real).isDirectory()) throw new Error("Saved-copy folder is not a directory");
    this.real = real;
  }

  private base(): string {
    if (!this.real) throw new Error("Saved-copy folder is not prepared");
    return this.real;
  }

  /** `path` as a real directory; absent is null, or made when `create`. A symlink or file is refused (create) or null. */
  private dir(path: string, create: boolean): string | null {
    const st = lstat(path);
    if (!st) {
      if (!create) return null;
      fs.mkdirSync(path);
      return path;
    }
    if (st.isDirectory() && !st.isSymbolicLink()) return path;
    if (create) throw refused();
    return null;
  }

  private linkDir(linkId: string, create: boolean): string | null {
    if (!LINK_DIR.test(linkId)) throw refused();
    return this.dir(join(this.base(), linkId), create);
  }

  private imagesDir(linkId: string, create: boolean): string | null {
    const link = this.linkDir(linkId, create);
    return link && this.dir(join(link, "images"), create);
  }

  private tmpDir(create: boolean): string | null {
    return this.dir(join(this.base(), TMP), create);
  }

  private open(path: string, flags: number): number {
    return fs.openSync(path, flags | fs.constants.O_NOFOLLOW, 0o600);
  }

  /** `path` as a real directory, or null; asynchronous, for the read path. */
  private async existingDir(path: string): Promise<string | null> {
    try {
      const st = await fs.promises.lstat(path);
      return st.isDirectory() && !st.isSymbolicLink() ? path : null;
    } catch (e) {
      if (code(e) === "ENOENT") return null;
      throw e;
    }
  }

  /** At most `max` bytes of a regular file: the stat refuses a bigger one, and so does a read reaching `max + 1`. */
  private async read(path: string, max: number): Promise<Buffer | null> {
    let handle: fs.promises.FileHandle | undefined;
    try {
      handle = await fs.promises.open(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      const st = await handle.stat();
      if (!st.isFile()) return null;
      if (st.size > max) throw new CopyFileTooLarge(`${path} is over ${max} bytes`);
      const buffer = Buffer.alloc(max + 1);
      let got = 0;
      while (got < buffer.length) {
        const { bytesRead } = await handle.read(buffer, got, buffer.length - got, null);
        if (bytesRead === 0) break;
        got += bytesRead;
      }
      if (got > max) throw new CopyFileTooLarge(`${path} grew over ${max} bytes`);
      return Buffer.from(buffer.subarray(0, got));
    } catch (e) {
      if (gone(e)) return null;
      throw e;
    } finally {
      await handle?.close();
    }
  }

  private writeNew(path: string, bytes: Uint8Array): void {
    const fd = this.open(path, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL);
    try {
      fs.writeSync(fd, bytes);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }

  private stagingName = () => `tmp-${randomBytes(16).toString("hex")}`;

  /** Writes `bytes` to a staging file, then renames it to `finalPath`. */
  private atomicWrite(finalPath: string, bytes: Uint8Array): void {
    const staged = join(this.tmpDir(true) as string, this.stagingName());
    try {
      this.writeNew(staged, bytes);
      fs.renameSync(staged, finalPath);
    } catch (e) {
      fs.rmSync(staged, { force: true });
      throw e;
    }
  }

  /** The marker's id, or null when there is none. Throws if the marker is a symlink. */
  readMarker(): string | null {
    const path = join(this.base(), MARKER);
    const st = lstat(path);
    if (!st) return null;
    if (!st.isFile()) throw new Error("The saved-copy marker is not a file");
    const fd = this.open(path, fs.constants.O_RDONLY);
    try {
      return fs.readFileSync(fd, "utf8").trim();
    } finally {
      fs.closeSync(fd);
    }
  }

  /** True when the root holds nothing but the marker and IGNORED_IN_EMPTY names. */
  isEmpty(): boolean {
    return fs
      .readdirSync(this.base())
      .every((n) => n === MARKER || IGNORED_IN_EMPTY.has(n) || STAGE_DIR.test(n));
  }

  writeMarker(id: string): void {
    this.atomicWrite(join(this.base(), MARKER), Buffer.from(id));
  }

  /**
   * Write check: TMP/write-check-<pid>, fsync, read back, rename into the root as a staging name
   * (so the root itself must be writable), delete. Throws on any failure.
   */
  probe(): void {
    const tmp = this.tmpDir(true) as string;
    const path = join(tmp, `write-check-${process.pid}`);
    const bytes = randomBytes(16);
    const renamed = join(this.base(), this.stagingName());
    try {
      fs.rmSync(path, { force: true });
      this.writeNew(path, bytes);
      const fd = this.open(path, fs.constants.O_RDONLY);
      try {
        if (!bytes.equals(fs.readFileSync(fd)))
          throw new Error("Write check read back differently");
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(path, renamed);
      fs.unlinkSync(renamed);
    } catch (e) {
      fs.rmSync(path, { force: true });
      fs.rmSync(renamed, { force: true });
      throw e;
    }
  }

  /**
   * Absent <linkId>: builds <TMP>/tmp-<hex>/copy.md and images/, renames it to <linkId>.
   * Existing real-folder <linkId> (an orphan, R6): removeCopy's names first, then copy.md by
   * staging-file rename and images/ created if missing. Returns the names it left.
   */
  writeCopy(linkId: string, markdown: string): string[] {
    if (!LINK_DIR.test(linkId)) throw refused();
    const target = join(this.base(), linkId);
    if (lstat(target)) {
      this.imagesDir(linkId, true); // refuses a symlink before anything is deleted
      const left = this.removeCopy(linkId);
      this.imagesDir(linkId, true);
      this.atomicWrite(join(target, "copy.md"), Buffer.from(markdown));
      return left;
    }
    const name = this.stagingName();
    const staged = join(this.tmpDir(true) as string, name);
    try {
      fs.mkdirSync(staged);
      fs.mkdirSync(join(staged, "images"));
      this.writeNew(join(staged, "copy.md"), Buffer.from(markdown));
      fs.renameSync(staged, target);
    } catch (e) {
      try {
        this.removeTemp(name);
      } catch {
        // a stale staging entry is the sweep's
      }
      throw e;
    }
    return [];
  }

  /** Whether <linkId>/copy.md is a regular file; a symlink is not. */
  hasCopyFile(linkId: string): boolean {
    const link = this.linkDir(linkId, false);
    return link !== null && lstat(join(link, "copy.md"))?.isFile() === true;
  }

  private imageName(name: string): string {
    if (!IMAGE_FILE.test(name)) throw refused();
    return name;
  }

  /** Throws CopyFolderMissing, creating nothing, unless <linkId>/copy.md is a regular file. */
  writeImage(linkId: string, name: string, bytes: Uint8Array): void {
    this.imageName(name);
    if (!this.hasCopyFile(linkId)) {
      throw new CopyFolderMissing(`Saved copy ${linkId} has no copy.md`);
    }
    const images = this.imagesDir(linkId, true) as string;
    this.atomicWrite(join(images, name), bytes);
  }

  /** Replaces an existing copy.md; false, creating nothing, when the folder or the file is gone. */
  replaceMarkdown(linkId: string, markdown: string): boolean {
    const link = this.linkDir(linkId, false);
    if (!link || !lstat(join(link, "copy.md"))) return false;
    this.atomicWrite(join(link, "copy.md"), Buffer.from(markdown));
    return true;
  }

  private async existingLinkDir(linkId: string): Promise<string | null> {
    if (!LINK_DIR.test(linkId)) throw refused();
    return this.existingDir(join(this.base(), linkId));
  }

  /** copy.md, refused with CopyFileTooLarge over MAX_COPY_MARKDOWN_BYTES. */
  async readMarkdown(linkId: string): Promise<string | null> {
    const link = await this.existingLinkDir(linkId);
    const bytes = link && (await this.read(join(link, "copy.md"), MAX_COPY_MARKDOWN_BYTES));
    return bytes ? bytes.toString("utf8") : null;
  }

  /** An image, refused with CopyFileTooLarge over MAX_IMAGE_BYTES. */
  async readImage(linkId: string, name: string): Promise<Uint8Array | null> {
    this.imageName(name);
    const link = await this.existingLinkDir(linkId);
    const images = link && (await this.existingDir(join(link, "images")));
    return images ? await this.read(join(images, name), MAX_IMAGE_BYTES) : null;
  }

  /**
   * Deletes copy.md, images/<IMAGE_FILE>, then the two folders if empty. Leaves any other name;
   * returns the names left, relative to the folder.
   */
  removeCopy(linkId: string): string[] {
    const link = this.linkDir(linkId, false);
    return link ? this.clear(link) : [];
  }

  /** The removeCopy deletion on a folder already known to be a real directory. */
  private clear(dir: string): string[] {
    const left: string[] = [];
    const drop = (path: string, label: string) => {
      try {
        fs.unlinkSync(path);
      } catch (e) {
        if (code(e) !== "ENOENT") left.push(label);
      }
    };
    const tidy = (path: string) => {
      try {
        fs.rmdirSync(path);
      } catch (e) {
        if (code(e) !== "ENOTEMPTY" && code(e) !== "ENOENT") throw e;
      }
    };
    drop(join(dir, "copy.md"), "copy.md");
    const images = this.dir(join(dir, "images"), false);
    if (images) {
      for (const n of fs.readdirSync(images)) {
        if (IMAGE_FILE.test(n)) drop(join(images, n), `images/${n}`);
        else left.push(`images/${n}`);
      }
      tidy(images);
    } else if (lstat(join(dir, "images"))) left.push("images");
    for (const n of fs.readdirSync(dir)) {
      if (n !== "copy.md" && n !== "images") left.push(n);
    }
    tidy(dir);
    return left;
  }

  removeImage(linkId: string, name: string): void {
    this.imageName(name);
    const images = this.imagesDir(linkId, false);
    if (!images) return;
    try {
      fs.unlinkSync(join(images, name));
    } catch (e) {
      if (code(e) !== "ENOENT") throw e;
    }
  }

  /** Entries of the root and of TMP with their mtime, for the sweep. Others are reported as unknown. */
  list(): {
    links: { name: string; mtimeMs: number }[];
    temp: { name: string; mtimeMs: number }[];
    other: string[];
  } {
    const base = this.base();
    const links: { name: string; mtimeMs: number }[] = [];
    const temp: { name: string; mtimeMs: number }[] = [];
    const other: string[] = [];
    for (const e of fs.readdirSync(base, { withFileTypes: true })) {
      if (e.name === MARKER || IGNORED_IN_EMPTY.has(e.name)) continue;
      if (STAGE_DIR.test(e.name)) {
        const staged = lstat(join(base, e.name));
        if (staged) temp.push({ name: e.name, mtimeMs: staged.mtimeMs });
        continue;
      }
      const st = LINK_DIR.test(e.name) && e.isDirectory() ? lstat(join(base, e.name)) : null;
      if (st) links.push({ name: e.name, mtimeMs: st.mtimeMs });
      else other.push(e.name);
    }
    const tmpPath = join(base, TMP);
    const tmp = lstat(tmpPath) && this.dir(tmpPath, false);
    if (tmp) {
      for (const n of fs.readdirSync(tmp)) {
        const st = STAGE_FILE.test(n) ? lstat(join(tmp, n)) : null;
        if (st) temp.push({ name: n, mtimeMs: st.mtimeMs });
        else other.push(`${TMP}/${n}`);
      }
    } else if (lstat(tmpPath)) other.push(TMP);
    return { links, temp, other };
  }

  /** Names in images/ matching IMAGE_FILE; others ignored. */
  listImages(linkId: string): string[] {
    const images = this.imagesDir(linkId, false);
    if (!images) return [];
    return fs.readdirSync(images).filter((n) => IMAGE_FILE.test(n));
  }

  /** Names in a link folder the store did not make, relative to it. Nothing is deleted. */
  unknownIn(linkId: string): string[] {
    const link = this.linkDir(linkId, false);
    if (!link) return [];
    const unknown = fs.readdirSync(link).filter((n) => n !== "copy.md" && n !== "images");
    const images = join(link, "images");
    const st = lstat(images);
    if (st && !(st.isDirectory() && !st.isSymbolicLink())) unknown.push("images");
    else if (st) {
      for (const n of fs.readdirSync(images)) if (!IMAGE_FILE.test(n)) unknown.push(`images/${n}`);
    }
    return unknown;
  }

  /**
   * Deletes a staging entry named tmp-<32 hex> or write-check-<digits>: a file, or a folder
   * holding only copy.md and images/<IMAGE_FILE>. Leaves anything else; returns the names left,
   * relative to TMP. A tmp-<hex> entry left in the root (by the write check) is treated the same.
   */
  removeTemp(name: string): string[] {
    if (!STAGE_FILE.test(name)) throw refused();
    const tmp = this.tmpDir(false);
    const inTmp = tmp ? join(tmp, name) : null;
    const inRoot = join(this.base(), name);
    const path = inTmp && lstat(inTmp) ? inTmp : STAGE_DIR.test(name) ? inRoot : null;
    const st = path && lstat(path);
    if (!path || !st) return [];
    if (!st.isDirectory() || st.isSymbolicLink()) {
      fs.unlinkSync(path);
      return [];
    }
    if (!STAGE_DIR.test(name)) return [name];
    return this.clear(path).map((n) => `${name}/${n}`);
  }
}
