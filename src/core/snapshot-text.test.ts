import { describe, expect, it, vi } from "vitest";
import { capCodePoints, EXCERPT_CHARS, readSnapshotText, TEXT_CHARS } from "./snapshot-text.js";
import type { Link, SnapshotStatus } from "./types.js";

const LONE_HIGH_SURROGATE_AT_END = /[\uD800-\uDBFF]$/;

describe.each([EXCERPT_CHARS, TEXT_CHARS])("capCodePoints at %i", (max) => {
  it("keeps text of exactly the cap whole", () => {
    const text = "a".repeat(max);
    expect(capCodePoints(text, max)).toEqual({ text, truncated: false });
  });

  it("cuts text one code point over the cap", () => {
    expect(capCodePoints("a".repeat(max + 1), max)).toEqual({
      text: "a".repeat(max),
      truncated: true,
    });
  });

  it("counts an astral character as one, not as its two UTF-16 units", () => {
    const text = "😀".repeat(max);
    expect(capCodePoints(text, max)).toEqual({ text, truncated: false });
  });

  it("never splits a surrogate pair at the cap", () => {
    const capped = capCodePoints(`${"a".repeat(max - 1)}😀b`, max);
    expect(capped).toEqual({ text: `${"a".repeat(max - 1)}😀`, truncated: true });
    expect(capped.text).not.toMatch(LONE_HIGH_SURROGATE_AT_END);
  });
});

describe("readSnapshotText", () => {
  const linkWith = (status: SnapshotStatus | null): Link => ({
    id: "7",
    url: "https://ex.com/a",
    urlKey: "ex.com/a",
    title: null,
    summary: null,
    why: null,
    tags: [],
    savedAt: new Date(0),
    savedBy: "agent",
    lastOpenedAt: null,
    lastSurfacedAt: null,
    snoozedUntil: null,
    state: "active",
    snapshot:
      status === null
        ? null
        : { status, fetchedAt: null, title: null, description: null, imageUrl: null },
  });
  const pagesWith = (text: string | null) => ({ getSnapshotText: vi.fn(async () => text) });

  it("reads the owner's text for an ok snapshot, capped", async () => {
    const pages = pagesWith("abcdef");
    expect(await readSnapshotText(pages, "owner-a", linkWith("ok"), 4)).toEqual({
      text: "abcd",
      truncated: true,
    });
    expect(pages.getSnapshotText).toHaveBeenCalledWith("owner-a", "7");
  });

  it("is null for an ok snapshot with no text", async () => {
    expect(await readSnapshotText(pagesWith(null), "owner-a", linkWith("ok"), 4)).toBeNull();
  });

  // The text must belong to the snapshot read with the link: only an ok one has text.
  it.each(["pending", "retrying", "failed", "extract_timeout", null] as const)(
    "is null, and reads no text, for a %s snapshot",
    async (status) => {
      const pages = pagesWith("text from a later moment");
      expect(await readSnapshotText(pages, "owner-a", linkWith(status), 4)).toBeNull();
      expect(pages.getSnapshotText).not.toHaveBeenCalled();
    },
  );

  it("is null without a reader", async () => {
    expect(await readSnapshotText(undefined, "owner-a", linkWith("ok"), 4)).toBeNull();
  });
});
