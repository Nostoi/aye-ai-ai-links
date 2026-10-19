import { describe, expect, it, vi } from "vitest";
import { copiesFull, copyNotice, copyUsageLevel, readCopyNotice } from "./copy-usage.js";
import { type FolderCheck, MAX_COPY_BYTES } from "./saved-copy.js";

const LIMIT = 1000 * MAX_COPY_BYTES;

describe("copiesFull", () => {
  it("is false with exactly MAX_COPY_BYTES free", () => {
    expect(copiesFull(LIMIT - MAX_COPY_BYTES, LIMIT)).toBe(false);
  });

  it("is true with one byte less than MAX_COPY_BYTES free", () => {
    expect(copiesFull(LIMIT - MAX_COPY_BYTES + 1, LIMIT)).toBe(true);
  });

  it("is true at limit 0", () => {
    expect(copiesFull(0, 0)).toBe(true);
  });
});

describe("copyUsageLevel", () => {
  it("is low one byte under 80% of the limit", () => {
    expect(copyUsageLevel(0.8 * LIMIT - 1, LIMIT)).toBe("low");
  });

  it("is high at 80% of the limit", () => {
    expect(copyUsageLevel(0.8 * LIMIT, LIMIT)).toBe("high");
  });

  it("is full when under MAX_COPY_BYTES is free", () => {
    expect(copyUsageLevel(LIMIT - MAX_COPY_BYTES + 1, LIMIT)).toBe("full");
  });
});

describe("copyNotice", () => {
  it("is null at limit 0 even when the folder is unwritable", () => {
    expect(copyNotice(0, 0, "unwritable")).toBeNull();
  });

  it("is paused for a mismatched folder, even when full", () => {
    expect(copyNotice(LIMIT, LIMIT, "mismatch")).toEqual({ kind: "paused" });
  });

  it("is full when full and the folder is ready", () => {
    expect(copyNotice(LIMIT, LIMIT, "ready")).toEqual({ kind: "full" });
  });

  it("is high with the bytes at 80%", () => {
    expect(copyNotice(0.8 * LIMIT, LIMIT, "ready")).toEqual({
      kind: "high",
      usedBytes: 0.8 * LIMIT,
      limitBytes: LIMIT,
    });
  });

  it("is null at 79%", () => {
    expect(copyNotice(0.79 * LIMIT, LIMIT, "ready")).toBeNull();
  });
});

describe("readCopyNotice", () => {
  const usage = (used: number, folder: FolderCheck = { state: "ready" }) => ({
    usedBytes: vi.fn(async () => used),
    lastCheck: () => folder,
  });

  it("never reads the usage at limit 0", async () => {
    const copies = usage(0);
    expect(await readCopyNotice(copies, 0)).toBeNull();
    expect(copies.usedBytes).not.toHaveBeenCalled();
  });

  it("never reads the usage while paused", async () => {
    const copies = usage(0, { state: "unwritable", detail: "x" });
    expect(await readCopyNotice(copies, LIMIT)).toEqual({ kind: "paused" });
    expect(copies.usedBytes).not.toHaveBeenCalled();
  });

  it("reads the usage when ready", async () => {
    expect(await readCopyNotice(usage(LIMIT), LIMIT)).toEqual({ kind: "full" });
  });
});
