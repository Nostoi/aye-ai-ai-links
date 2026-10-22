/**
 * CPU budgets for tests that guard against slow (quadratic) work. Wall time on a busy machine is
 * several times the CPU time, so a budget on it fails under load (#236); this thread's CPU time
 * barely moves. It sees only this thread, so it suits work done here and nothing that runs in
 * another thread or process.
 */

const cpuSince = (start: NodeJS.CpuUsage) => {
  const { user, system } = process.threadCpuUsage(start);
  return (user + system) / 1000;
};

/** Runs `run` and returns its result with the CPU time this thread spent on it, in ms. */
export function cpuTimed<T>(run: () => T & { then?: never }): { result: T; ms: number } {
  const start = process.threadCpuUsage();
  const result = run();
  if (typeof (result as { then?: unknown } | null)?.then === "function") {
    throw new TypeError("cpuTimed would stop at the first await: use cpuTimedAsync");
  }
  return { result, ms: cpuSince(start) };
}

/** As `cpuTimed`, through every await until `run` settles. */
export async function cpuTimedAsync<T>(run: () => Promise<T>): Promise<{ result: T; ms: number }> {
  const start = process.threadCpuUsage();
  const result = await run();
  return { result, ms: cpuSince(start) };
}

/** The test timeout for a CPU budget test: vitest's timeout is wall time, which load stretches. */
export const CPU_BUDGET_TIMEOUT_MS = 120_000;
