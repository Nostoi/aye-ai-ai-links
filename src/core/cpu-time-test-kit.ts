/**
 * CPU budgets for tests that guard against slow (quadratic) work. Wall time on a busy machine is
 * several times the CPU time, so a budget on it fails under load (#236); this thread's CPU time
 * barely moves. It sees only this thread, so it suits synchronous work and nothing that runs in
 * another thread or process.
 */

/** Runs `run` and returns its result with the CPU time this thread spent on it, in ms. */
export function cpuTimed<T>(run: () => T): { result: T; ms: number } {
  const start = process.threadCpuUsage();
  const result = run();
  const { user, system } = process.threadCpuUsage(start);
  return { result, ms: (user + system) / 1000 };
}

/** The test timeout for a CPU budget test: vitest's timeout is wall time, which load stretches. */
export const CPU_BUDGET_TIMEOUT_MS = 120_000;
