import type { LookupAddress } from "node:dns";
import { describe, expect, it } from "vitest";
import { guardedLookup, RefusedAddressError } from "./guarded-lookup.js";

const PUBLIC: LookupAddress = { address: "8.8.8.8", family: 4 };
const PUBLIC_V6: LookupAddress = { address: "2606:4700::1111", family: 6 };
const PRIVATE: LookupAddress = { address: "10.0.0.5", family: 4 };

const publicOnly = (ip: string) => !ip.startsWith("10.");

function lookup(
  answer: LookupAddress[] | Error,
  options: { all?: boolean } = {},
): Promise<{ err: Error | null; address?: unknown; family?: number }> {
  const resolve = async () => {
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return new Promise((done) => {
    guardedLookup(resolve, publicOnly)("host.test", options, (err, address, family) =>
      done({ err, address, family }),
    );
  });
}

describe("guardedLookup", () => {
  it("answers every address when asked for all", async () => {
    const r = await lookup([PUBLIC, PUBLIC_V6], { all: true });
    expect(r.err).toBeNull();
    expect(r.address).toEqual([PUBLIC, PUBLIC_V6]);
  });

  it("answers one address and its family when not asked for all", async () => {
    const r = await lookup([PUBLIC, PUBLIC_V6]);
    expect(r.err).toBeNull();
    expect(r.address).toBe("8.8.8.8");
    expect(r.family).toBe(4);
  });

  it.each([
    ["private last", [PUBLIC, PRIVATE]],
    ["private first", [PRIVATE, PUBLIC]],
  ])("refuses a mixed answer (%s), whatever shape was asked for", async (_name, answer) => {
    for (const all of [true, false]) {
      const r = await lookup(answer, { all });
      expect(r.err).toBeInstanceOf(RefusedAddressError);
    }
  });

  it("fails with ENOTFOUND on an empty answer", async () => {
    const r = await lookup([], { all: true });
    expect((r.err as NodeJS.ErrnoException).code).toBe("ENOTFOUND");
  });

  it("passes a resolver failure to the callback", async () => {
    const boom = Object.assign(new Error("boom"), { code: "ESERVFAIL" });
    const r = await lookup(boom, { all: true });
    expect(r.err).toBe(boom);
  });
});
