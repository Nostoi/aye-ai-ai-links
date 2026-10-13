import { describe, expect, it } from "vitest";
import { createAuthLock } from "./auth-lock.js";

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

const tick = () => new Promise((r) => setTimeout(r, 5));

describe("createAuthLock", () => {
  it("runs one call at a time, in arrival order", async () => {
    const withAuthLock = createAuthLock();
    const log: string[] = [];
    const first = gate();
    const a = withAuthLock(async () => {
      log.push("a in");
      await first.opened;
      log.push("a out");
      return "a";
    });
    const b = withAuthLock(async () => {
      log.push("b in");
      return "b";
    });
    await tick();
    expect(log).toEqual(["a in"]);
    first.open();
    expect(await Promise.all([a, b])).toEqual(["a", "b"]);
    expect(log).toEqual(["a in", "a out", "b in"]);
  });

  it("passes a failure to its caller and still runs the next call", async () => {
    const withAuthLock = createAuthLock();
    const boom = new Error("boom");
    const failed = withAuthLock(async () => {
      throw boom;
    });
    const next = withAuthLock(async () => "next");
    await expect(failed).rejects.toBe(boom);
    expect(await next).toBe("next");
  });

  it("gives each lock its own queue", async () => {
    const one = createAuthLock();
    const two = createAuthLock();
    const held = gate();
    void one(() => held.opened);
    expect(await two(async () => "free")).toBe("free");
    held.open();
  });
});
