import { describe, expect, it } from "vitest";
import { cpuTimed, cpuTimedAsync } from "./cpu-time-test-kit.js";

const busy = () => {
  let x = 0;
  for (let i = 0; i < 50_000_000; i++) x = (x + i) % 7919;
  return x;
};

describe("cpuTimed", () => {
  it("leaves out time the thread spends waiting", () => {
    const wait = new Int32Array(new SharedArrayBuffer(4));
    const { ms } = cpuTimed(() => Atomics.wait(wait, 0, 0, 300));
    expect(ms).toBeLessThan(100);
  });

  it("counts the thread's own work in milliseconds, as the process's CPU time does", () => {
    const before = process.cpuUsage();
    const { result, ms } = cpuTimed(busy);
    const { user, system } = process.cpuUsage(before);
    expect(result).toBeTypeOf("number");
    expect(ms).toBeGreaterThan(0);
    expect(ms).toBeLessThanOrEqual((user + system) / 1000);
    expect(ms).toBeGreaterThan((user + system) / 1000 / 2);
  });

  it("refuses work that returns a promise, since it would stop at the first await", () => {
    // @ts-expect-error an async run belongs to cpuTimedAsync
    expect(() => cpuTimed(async () => busy())).toThrow(/cpuTimedAsync/);
  });
});

describe("cpuTimedAsync", () => {
  it("counts the work after an await, and returns what it resolves to", async () => {
    const { result, ms } = await cpuTimedAsync(async () => {
      await new Promise((resolve) => setImmediate(resolve));
      return busy();
    });
    const alone = cpuTimed(busy).ms;
    expect(result).toBeTypeOf("number");
    expect(ms).toBeGreaterThan(alone / 2);
  });
});
