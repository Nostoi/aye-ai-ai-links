import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CopyFolder, MARKER, TMP } from "./copy-folder.js";

const HEX = "0123456789abcdef0123456789abcdef";
const stage = `tmp-${HEX}`;
const asRoot = process.getuid?.() === 0;

let dirs: string[] = [];
let root: string;
let folder: CopyFolder;

const fresh = (prefix = "copy-folder-") => {
  const d = fs.mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
};
const tmpNames = () => {
  const p = join(root, TMP);
  return fs.existsSync(p) ? fs.readdirSync(p) : [];
};
const text = (p: string) => fs.readFileSync(p, "utf8");

beforeEach(() => {
  root = fresh();
  folder = new CopyFolder(root);
  folder.prepare();
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs) {
    fs.chmodSync(d, 0o700);
    fs.rmSync(d, { recursive: true, force: true });
  }
  dirs = [];
});

describe("CopyFolder setup", () => {
  it("needs an absolute root and a prepare() before use", () => {
    expect(() => new CopyFolder("relative/dir")).toThrow();
    expect(() => new CopyFolder(root).isEmpty()).toThrow();
  });

  it("creates a missing root", () => {
    const made = join(fresh(), "nested", "copies");
    new CopyFolder(made).prepare();
    expect(fs.statSync(made).isDirectory()).toBe(true);
  });

  it("works through a root that is a symlink, writing into the real folder", () => {
    const real = fresh();
    const link = join(fresh(), "link");
    fs.symlinkSync(real, link);
    const f = new CopyFolder(link);
    f.prepare();
    f.writeCopy("12", "hello");
    expect(text(join(real, "12", "copy.md"))).toBe("hello");
  });
});

describe("isEmpty", () => {
  it("ignores the marker and sync-client files", () => {
    expect(folder.isEmpty()).toBe(true);
    fs.writeFileSync(join(root, ".DS_Store"), "");
    fs.writeFileSync(join(root, "Icon\r"), "");
    expect(folder.isEmpty()).toBe(true);
  });
  it("ignores .aye-tmp", () => {
    fs.mkdirSync(join(root, TMP));
    expect(folder.isEmpty()).toBe(true);
  });
  it("is false with a link folder or a stray file", () => {
    fs.mkdirSync(join(root, "12"));
    expect(folder.isEmpty()).toBe(false);
    fs.rmdirSync(join(root, "12"));
    fs.writeFileSync(join(root, "notes.txt"), "");
    expect(folder.isEmpty()).toBe(false);
  });
});

describe("marker", () => {
  it("is null until written, then round-trips", () => {
    expect(folder.readMarker()).toBeNull();
    folder.writeMarker("lib-1");
    expect(folder.readMarker()).toBe("lib-1");
    expect(tmpNames()).toEqual([]);
  });
  it("refuses a marker that is a symlink", () => {
    const elsewhere = join(fresh(), "m");
    fs.writeFileSync(elsewhere, "x");
    fs.symlinkSync(elsewhere, join(root, MARKER));
    expect(() => folder.readMarker()).toThrow();
  });
});

describe("probe", () => {
  it("passes on a writable root and leaves nothing behind", () => {
    folder.probe();
    expect(tmpNames()).toEqual([]);
  });
  it.skipIf(asRoot)("throws on a root that cannot be written, and works again after", () => {
    fs.mkdirSync(join(root, TMP));
    fs.chmodSync(join(root, TMP), 0o500);
    fs.chmodSync(root, 0o500);
    expect(() => folder.probe()).toThrow();
    fs.chmodSync(root, 0o700);
    fs.chmodSync(join(root, TMP), 0o700);
    folder.probe();
  });
});

describe("writeCopy", () => {
  it("round-trips and leaves nothing in .aye-tmp", async () => {
    expect(folder.writeCopy("12", "# hi")).toEqual([]);
    expect(await folder.readMarkdown("12")).toBe("# hi");
    expect(fs.statSync(join(root, "12", "images")).isDirectory()).toBe(true);
    expect(tmpNames()).toEqual([]);
  });

  it("replaces an orphan's store-made names, keeps other files and reports them", async () => {
    const d = join(root, "12");
    fs.mkdirSync(join(d, "images"), { recursive: true });
    fs.writeFileSync(join(d, "copy.md"), "old");
    fs.writeFileSync(join(d, "images", "01.png"), "png");
    fs.writeFileSync(join(d, "copy.md (conflicted copy)"), "theirs");
    const left = folder.writeCopy("12", "new");
    expect(await folder.readMarkdown("12")).toBe("new");
    expect(fs.existsSync(join(d, "images", "01.png"))).toBe(false);
    expect(fs.statSync(join(d, "images")).isDirectory()).toBe(true);
    expect(text(join(d, "copy.md (conflicted copy)"))).toBe("theirs");
    expect(left).toEqual(["copy.md (conflicted copy)"]);
    expect(tmpNames()).toEqual([]);
  });

  it("leaves no folder and no staging entry when the final rename fails", () => {
    const real = fs.renameSync;
    let thrown = false;
    vi.spyOn(fs, "renameSync").mockImplementation((a, b) => {
      if (!thrown) {
        thrown = true;
        throw new Error("EIO");
      }
      real(a, b);
    });
    expect(() => folder.writeCopy("12", "x")).toThrow("EIO");
    expect(fs.existsSync(join(root, "12"))).toBe(false);
    expect(tmpNames()).toEqual([]);
  });

  it("refuses a link folder that is a symlink and leaves its target alone", async () => {
    const target = fresh();
    fs.writeFileSync(join(target, "copy.md"), "theirs");
    fs.symlinkSync(target, join(root, "12"));
    expect(() => folder.writeCopy("12", "mine")).toThrow("Refused saved-copy path");
    expect(text(join(target, "copy.md"))).toBe("theirs");
    expect(await folder.readMarkdown("12")).toBeNull();
  });
});

describe("images", () => {
  it("writes, lists, reads and removes an image", async () => {
    folder.writeCopy("12", "x");
    folder.writeImage("12", "01.png", new Uint8Array([1, 2, 3]));
    folder.writeImage("12", "02.jpg", new Uint8Array([4]));
    fs.writeFileSync(join(root, "12", "images", "notes.txt"), "");
    expect(folder.listImages("12").sort()).toEqual(["01.png", "02.jpg"]);
    expect([...((await folder.readImage("12", "01.png")) ?? [])]).toEqual([1, 2, 3]);
    folder.removeImage("12", "01.png");
    expect(await folder.readImage("12", "01.png")).toBeNull();
    expect(tmpNames()).toEqual([]);
  });

  it("refuses an images folder that is a symlink", async () => {
    folder.writeCopy("12", "x");
    const target = fresh();
    fs.rmdirSync(join(root, "12", "images"));
    fs.symlinkSync(target, join(root, "12", "images"));
    expect(() => folder.writeImage("12", "01.png", new Uint8Array([1]))).toThrow();
    expect(fs.readdirSync(target)).toEqual([]);
    expect(await folder.readImage("12", "01.png")).toBeNull();
  });
});

describe("copy.md as a symlink", () => {
  it("is not read, and replaceMarkdown replaces the link not its target", async () => {
    folder.writeCopy("12", "x");
    const outside = join(fresh(), "secret.txt");
    fs.writeFileSync(outside, "secret");
    fs.rmSync(join(root, "12", "copy.md"));
    fs.symlinkSync(outside, join(root, "12", "copy.md"));
    expect(await folder.readMarkdown("12")).toBeNull();
    folder.replaceMarkdown("12", "fresh");
    expect(text(outside)).toBe("secret");
    expect(await folder.readMarkdown("12")).toBe("fresh");
  });
});

describe("refused names", () => {
  it.each(["../x", "1a", "", "123456789012345678901"])("refuses link id %j", async (id) => {
    expect(() => folder.writeCopy(id, "x")).toThrow("Refused saved-copy path");
    await expect(folder.readMarkdown(id)).rejects.toThrow("Refused saved-copy path");
    expect(() => folder.removeCopy(id)).toThrow("Refused saved-copy path");
  });
  it.each(["01.svg", "1.png", "../01.png", "01.png/x"])("refuses image name %j", async (name) => {
    folder.writeCopy("12", "x");
    expect(() => folder.writeImage("12", name, new Uint8Array([1]))).toThrow(
      "Refused saved-copy path",
    );
    await expect(folder.readImage("12", name)).rejects.toThrow("Refused saved-copy path");
    expect(() => folder.removeImage("12", name)).toThrow("Refused saved-copy path");
  });
});

describe("removeCopy", () => {
  it("deletes its own names, keeps and reports others, keeps the folder", () => {
    folder.writeCopy("12", "x");
    folder.writeImage("12", "01.png", new Uint8Array([1]));
    fs.writeFileSync(join(root, "12", "copy.md (conflicted copy)"), "theirs");
    expect(folder.removeCopy("12")).toEqual(["copy.md (conflicted copy)"]);
    expect(fs.existsSync(join(root, "12", "copy.md"))).toBe(false);
    expect(fs.existsSync(join(root, "12", "images"))).toBe(false);
    expect(text(join(root, "12", "copy.md (conflicted copy)"))).toBe("theirs");
  });
  it("removes the folders when nothing else is in them", () => {
    folder.writeCopy("12", "x");
    expect(folder.removeCopy("12")).toEqual([]);
    expect(fs.existsSync(join(root, "12"))).toBe(false);
  });
  it("does nothing for a missing copy or a symlinked folder", () => {
    expect(folder.removeCopy("12")).toEqual([]);
    const target = fresh();
    fs.writeFileSync(join(target, "copy.md"), "theirs");
    fs.symlinkSync(target, join(root, "13"));
    expect(folder.removeCopy("13")).toEqual([]);
    expect(text(join(target, "copy.md"))).toBe("theirs");
  });
});

describe("list and removeTemp", () => {
  const mkStage = (name: string, files: Record<string, string>) => {
    const d = join(root, TMP, name);
    for (const [rel, body] of Object.entries(files)) {
      fs.mkdirSync(join(d, rel, ".."), { recursive: true });
      fs.writeFileSync(join(d, rel), body);
    }
    return d;
  };

  it("sorts entries into links, staging names and others", () => {
    folder.writeCopy("12", "x");
    fs.writeFileSync(join(root, "notes.txt"), "");
    fs.writeFileSync(join(root, ".DS_Store"), "");
    folder.writeMarker("lib");
    mkStage(stage, { "copy.md": "x" });
    fs.writeFileSync(join(root, TMP, "write-check-77"), "");
    fs.writeFileSync(join(root, TMP, "other-name"), "keep");
    const l = folder.list();
    expect(l.links.map((e) => e.name)).toEqual(["12"]);
    expect(l.links[0]?.mtimeMs).toBeGreaterThan(0);
    expect(l.temp.map((e) => e.name).sort()).toEqual([stage, "write-check-77"].sort());
    expect(l.other.sort()).toEqual([".aye-tmp/other-name", "notes.txt"]);
  });

  it("deletes a stale staging folder holding only the store's names", () => {
    const d = mkStage(stage, { "copy.md": "x", "images/02.jpg": "j" });
    expect(folder.removeTemp(stage)).toEqual([]);
    expect(fs.existsSync(d)).toBe(false);
  });

  it("leaves and reports anything else inside a staging folder", () => {
    const d = mkStage(stage, { "copy.md": "x", "notes.txt": "mine" });
    expect(folder.removeTemp(stage)).toEqual([`${stage}/notes.txt`]);
    expect(fs.existsSync(join(d, "copy.md"))).toBe(false);
    expect(text(join(d, "notes.txt"))).toBe("mine");
  });

  it("deletes a staging file but never an unknown name", () => {
    fs.mkdirSync(join(root, TMP), { recursive: true });
    fs.writeFileSync(join(root, TMP, "write-check-77"), "");
    fs.writeFileSync(join(root, TMP, "other-name"), "keep");
    expect(folder.removeTemp("write-check-77")).toEqual([]);
    expect(() => folder.removeTemp("other-name")).toThrow("Refused saved-copy path");
    expect(text(join(root, TMP, "other-name"))).toBe("keep");
  });

  it("does not follow a staging name that is a symlink", () => {
    const target = fresh();
    fs.writeFileSync(join(target, "copy.md"), "theirs");
    fs.mkdirSync(join(root, TMP), { recursive: true });
    fs.symlinkSync(target, join(root, TMP, stage));
    folder.removeTemp(stage);
    expect(text(join(target, "copy.md"))).toBe("theirs");
  });
});
