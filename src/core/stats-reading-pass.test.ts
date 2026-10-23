import { afterEach, describe, expect, it } from "vitest";
import { FakeProfileStore } from "./fake-profile-store.js";
import { FakeStore } from "./fake-store.js";
import { at, newLink } from "./snapshot-store-contract.js";
import {
  createStatsReadingPass,
  READING_EVERY_MS,
  READING_MAX,
  type StatsReader,
} from "./stats-reading-pass.js";

const OWNER = "o";
const MINUTE = 60_000;
const DAY = 86_400_000;

type Answer = (signal: AbortSignal) => Promise<string> | string;

const running: { stop(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((p) => p.stop()));
});

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function setup(answer: Answer = () => "You saved a little.") {
  const store = new FakeStore();
  let calls = 0;
  const reader: StatsReader = {
    read: async (_input, signal) => {
      calls += 1;
      return answer(signal);
    },
  };
  let clock = at(1000).getTime();
  const logged: string[] = [];
  const pass = createStatsReadingPass({
    readings: store,
    store,
    tools: store,
    stats: store,
    profile: new FakeProfileStore(),
    reader,
    writtenBy: "Claude",
    now: () => new Date(clock),
    log: (m) => logged.push(m),
  });
  running.push(pass);
  return {
    store,
    pass,
    logged,
    calls: () => calls,
    advance: (ms: number) => {
      clock += ms;
    },
    seed: (n: number) => store.insertIfAbsent(OWNER, newLink(n, at(0))),
  };
}

describe("the stats reading pass", () => {
  it("writes a first reading", async () => {
    const t = setup();
    await t.seed(1);
    await t.pass.sweep();
    const reading = await t.store.getReading(OWNER);
    expect(reading?.text).toBe("You saved a little.");
    expect(reading?.writtenBy).toBe("Claude");
    expect(reading?.writtenAt).toEqual(at(1000));
    expect(reading?.inputHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("writes nothing when the stats are unchanged", async () => {
    const t = setup();
    await t.seed(1);
    await t.pass.sweep();
    const first = await t.store.getReading(OWNER);
    t.advance(READING_EVERY_MS + DAY);
    await t.pass.sweep();
    expect(t.calls()).toBe(1);
    expect(await t.store.getReading(OWNER)).toEqual(first);
  });

  it("rewrites after 7 days when the stats changed", async () => {
    let text = "first";
    const t = setup(() => text);
    await t.seed(1);
    await t.pass.sweep();
    const first = await t.store.getReading(OWNER);
    await t.seed(2);
    text = "second";
    t.advance(READING_EVERY_MS + DAY);
    await t.pass.sweep();
    const next = await t.store.getReading(OWNER);
    expect(next?.text).toBe("second");
    expect(next?.inputHash).not.toBe(first?.inputHash);
    expect(next?.writtenAt).toEqual(new Date(at(1000).getTime() + READING_EVERY_MS + DAY));
  });

  it("does not rewrite within 7 days even if the stats changed", async () => {
    const t = setup();
    await t.seed(1);
    await t.pass.sweep();
    const first = await t.store.getReading(OWNER);
    await t.seed(2);
    t.advance(READING_EVERY_MS - MINUTE);
    await t.pass.sweep();
    expect(t.calls()).toBe(1);
    expect(await t.store.getReading(OWNER)).toEqual(first);
  });

  it("a refused reply keeps the old reading and backs off", async () => {
    let reply: Answer = () => "kept";
    const t = setup((signal) => reply(signal));
    await t.seed(1);
    await t.pass.sweep();
    const first = await t.store.getReading(OWNER);
    await t.seed(2);
    t.advance(READING_EVERY_MS + DAY);
    for (const bad of [
      () => "   ",
      () => "x".repeat(READING_MAX + 1),
      () => {
        throw new Error("down");
      },
    ]) {
      reply = bad;
      const before = t.calls();
      await t.pass.sweep();
      expect(t.calls()).toBe(before + 1);
      expect(await t.store.getReading(OWNER)).toEqual(first);
      // Within the backoff the owner is skipped.
      await t.pass.sweep();
      expect(t.calls()).toBe(before + 1);
      // Past it (60 s, then 120 s, then 240 s) the owner is tried again.
      t.advance(10 * MINUTE);
    }
    expect(t.logged.length).toBe(3);
    reply = () => "recovered";
    await t.pass.sweep();
    expect((await t.store.getReading(OWNER))?.text).toBe("recovered");
  });

  it("stop aborts the call and writes nothing", async () => {
    const late = deferred<string>();
    let signal: AbortSignal | undefined;
    const t = setup((s) => {
      signal = s;
      return late.promise;
    });
    await t.seed(1);
    const sweeping = t.pass.sweep();
    await new Promise((r) => setTimeout(r, 10));
    await t.pass.stop();
    expect(signal?.aborted).toBe(true);
    late.resolve("too late");
    await sweeping;
    await new Promise((r) => setTimeout(r, 10));
    expect(await t.store.getReading(OWNER)).toBeNull();
  });
});
