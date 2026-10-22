import { describe, expect, it } from "vitest";
import { cpuTimed } from "./cpu-time-test-kit.js";

describe("cpuTimed", () => {
  it("leaves out time the thread spends waiting", () => {
    const wait = new Int32Array(new SharedArrayBuffer(4));
    const { ms } = cpuTimed(() => Atomics.wait(wait, 0, 0, 300));
    expect(ms).toBeLessThan(100);
  });

  it("counts the thread's own work in milliseconds, as the process's CPU time does", () => {
    const before = process.cpuUsage();
    const { result, ms } = cpuTimed(() => {
      let x = 0;
      for (let i = 0; i < 50_000_000; i++) x = (x + i) % 7919;
      return x;
    });
    const { user, system } = process.cpuUsage(before);
    expect(result).toBeTypeOf("number");
    expect(ms).toBeGreaterThan(0);
    expect(ms).toBeLessThanOrEqual((user + system) / 1000);
    expect(ms).toBeGreaterThan((user + system) / 1000 / 2);
  });
});
