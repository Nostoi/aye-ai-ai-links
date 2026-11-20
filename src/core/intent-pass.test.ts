import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeStore } from "./fake-store.js";
import {
  createIntentPass,
  type GuessLink,
  type IntentGuesser,
  IntentGuesserUnavailable,
} from "./intent-pass.js";
import { at, newLink } from "./snapshot-store-contract.js";

const OWNER = "o";
const MINUTE = 60_000;

type Answer = (links: GuessLink[], signal: AbortSignal) => Promise<number[]> | number[];

const running: { stop(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((p) => p.stop()));
  vi.useRealTimers();
});

function setup(answer: Answer = () => []) {
  const store = new FakeStore();
  /** The titles each call carried, in order. */
  const calls: string[][] = [];
  const signals: AbortSignal[] = [];
  const guesser: IntentGuesser = {
    guess: async (links, signal) => {
      calls.push(links.map((l) => l.title));
      signals.push(signal);
      return answer(links, signal);
    },
  };
  let clock = at(1000).getTime();
  const logged: string[] = [];
  const make = () => {
    const pass = createIntentPass({
      store,
      guesser,
      now: () => new Date(clock),
      log: (message) => logged.push(message),
      gapMs: 0,
    });
    running.push(pass);
    return pass;
  };
  return {
    store,
    calls,
    signals,
    logged,
    pass: make(),
    make,
    advance: (ms: number) => {
      clock += ms;
    },
    /** Links titled `L1`, `L2`, ... saved and queued, as the migration would queue them. */
    async seed(count: number, from = 1) {
      const ids: string[] = [];
      for (let n = from; n < from + count; n++) {
        const { link } = await store.insertIfAbsent(OWNER, {
          ...newLink(n, at(0)),
          title: `L${n}`,
        });
        store.queueGuess(OWNER, link.id);
        ids.push(link.id);
      }
      return ids;
    },
    held: (id: string) => store.get(OWNER, id).then((l) => [l?.intent, l?.intentSource]),
    outcomes: () => Object.fromEntries(store.guessRows(OWNER).map((r) => [r.id, r.outcome])),
    tries: () => store.guessRows(OWNER).map((r) => r.tries),
  };
}

/** Answers with the 1-based positions of the links whose title is in `keep`. */
const keeping =
  (...keep: string[]): Answer =>
  (links) =>
    links.flatMap((l, i) => (keep.includes(l.title) ? [i + 1] : []));

describe("intent pass", () => {
  it("sends only queued links, with what the owner knows of each, and never a link saved later", async () => {
    let sent: GuessLink[] = [];
    const t = setup((links) => {
      sent = links;
      return [];
    });
    const [id] = await t.seed(1);
    const tag = {
      key: "bills",
      name: "Bills",
      source: "stated",
      kind: "topic",
      kindSource: "stated",
    } as const;
    await t.store.update(OWNER, id as string, {
      why: { text: "Pay the gas bill", source: "stated" },
      summary: "Gas account page",
      summarySource: "server",
      tags: [tag],
    });
    await t.store.pinTag(OWNER, "bills", { pinned: true, color: "#123456" });
    await t.store.insertIfAbsent(OWNER, { ...newLink(99, at(5)), title: "Later" });
    await t.pass.sweep();
    expect(t.calls).toEqual([["L1"]]);
    expect(sent).toEqual([
      {
        title: "L1",
        site: "ex.com",
        path: "/1",
        tags: [{ name: "Bills", pinned: true }],
        why: { text: "Pay the gas bill", source: "stated" },
        summary: "Gas account page",
      },
    ]);
  });

  it("writes keep/inferred for the named links and records every outcome; the rest stay To explore", async () => {
    const t = setup(keeping("L2"));
    const [a, b, c] = await t.seed(3);
    await t.pass.sweep();
    expect(await t.held(a as string)).toEqual(["explore", null]);
    expect(await t.held(b as string)).toEqual(["keep", "inferred"]);
    expect(await t.held(c as string)).toEqual(["explore", null]);
    expect(t.outcomes()).toEqual({
      [a as string]: "not_keep",
      [b as string]: "keep",
      [c as string]: "not_keep",
    });
  });

  it("lets an owner's choice made during the call win, and sends nothing for a link already spoken for", async () => {
    let id = "";
    const t = setup(async () => {
      await t.store.update(OWNER, id, { intent: "explore", intentSource: "stated" });
      return [1];
    });
    [id] = (await t.seed(1)) as [string];
    await t.pass.sweep();
    expect(await t.held(id)).toEqual(["explore", "stated"]);
    expect(t.outcomes()).toEqual({ [id]: "not_keep" });

    const u = setup();
    const [spoken] = await u.seed(1);
    await u.store.update(OWNER, spoken as string, { intent: "keep", intentSource: "asked" });
    await u.pass.sweep();
    expect(u.calls).toEqual([]);
    expect(await u.held(spoken as string)).toEqual(["keep", "asked"]);
    expect(u.outcomes()).toEqual({ [spoken as string]: "not_keep" });
  });

  it("takes at most 25 links to a call, one call per batch", async () => {
    const t = setup();
    await t.seed(60);
    await t.pass.sweep();
    expect(t.calls.map((c) => c.length)).toEqual([25, 25, 10]);
    expect(Object.values(t.outcomes()).every((o) => o === "not_keep")).toBe(true);
  });

  describe("a reply that is not usable", () => {
    const writesNothing = async (answer: Answer, count = 3) => {
      const t = setup(answer);
      const ids = await t.seed(count);
      await t.pass.sweep();
      for (const id of ids) expect(await t.held(id)).toEqual(["explore", null]);
      expect(Object.values(t.outcomes())).toEqual(ids.map(() => null));
      expect(t.tries()).toEqual(ids.map(() => 1));
      return t;
    };

    it("an error from the guesser writes nothing and adds a try", async () => {
      await writesNothing(() => {
        throw new Error("the reply was not JSON");
      });
    });

    it("a number outside 1..N writes nothing, even beside valid ones", async () => {
      await writesNothing(() => [1, 4]);
      await writesNothing(() => [0]);
    });

    it("more than 8 of a batch writes nothing, and exactly 8 is written", async () => {
      await writesNothing((links) => links.map((_, i) => i + 1), 9);
      const t = setup((links) => links.slice(0, 8).map((_, i) => i + 1));
      const ids = await t.seed(25);
      await t.pass.sweep();
      expect(Object.values(t.outcomes()).filter((o) => o === "keep")).toHaveLength(8);
      expect(await t.held(ids[0] as string)).toEqual(["keep", "inferred"]);
      expect(await t.held(ids[8] as string)).toEqual(["explore", null]);
    });
  });

  describe("failures", () => {
    /** Fails every call that carries the link titled `bad`. */
    const poisoned =
      (bad: string): Answer =>
      (links) => {
        if (links.some((l) => l.title === bad)) throw new Error("garbled");
        return [];
      };

    it("a failing batch backs off alone, a retry is cut to 5 links, and its link ends failed after 3 tries while the others finish", async () => {
      const t = setup(poisoned("L3"));
      const ids = await t.seed(30);
      await t.pass.sweep();
      expect(t.calls.map((c) => c.length)).toEqual([25, 5]);
      expect(t.outcomes()[ids[29] as string]).toBe("not_keep");

      t.advance(MINUTE);
      await t.pass.sweep();
      expect(t.calls.slice(2).map((c) => c.length)).toEqual([5, 5, 5, 5, 5]);

      t.advance(2 * MINUTE);
      await t.pass.sweep();
      expect(ids.map((id) => t.outcomes()[id])).toEqual([
        ...Array(5).fill("failed"),
        ...Array(25).fill("not_keep"),
      ]);
      expect(await t.held(ids[2] as string)).toEqual(["explore", null]);
      const callsBefore = t.calls.length;
      await t.pass.sweep();
      expect(t.calls).toHaveLength(callsBefore);
    });

    it("waits out the backoff before trying a failed batch again", async () => {
      const t = setup(poisoned("L1"));
      await t.seed(2);
      await t.pass.sweep();
      await t.pass.sweep();
      expect(t.calls).toHaveLength(1);
      t.advance(MINUTE);
      await t.pass.sweep();
      expect(t.calls).toHaveLength(2);
      t.advance(MINUTE);
      await t.pass.sweep();
      expect(t.calls).toHaveLength(2);
      t.advance(MINUTE);
      await t.pass.sweep();
      expect(t.calls).toHaveLength(3);
    });

    it("three failed batches in a row pause the pass, then it carries on", async () => {
      const t = setup(() => {
        throw new Error("garbled");
      });
      await t.seed(80);
      await t.pass.sweep();
      expect(t.calls).toHaveLength(3);
      expect(t.logged.some((m) => m.includes("paused"))).toBe(true);
      await t.pass.sweep();
      expect(t.calls).toHaveLength(3);
      t.advance(MINUTE);
      await t.pass.sweep();
      expect(t.calls.length).toBeGreaterThan(3);
    });

    it("an unavailable AI pauses the pass and adds no try", async () => {
      const t = setup(() => {
        throw new IntentGuesserUnavailable("down");
      });
      await t.seed(30);
      await t.pass.sweep();
      expect(t.calls).toHaveLength(1);
      expect(t.tries().every((n) => n === 0)).toBe(true);
      await t.pass.sweep();
      expect(t.calls).toHaveLength(1);
      t.advance(MINUTE);
      await t.pass.sweep();
      expect(t.calls).toHaveLength(2);
    });
  });

  describe("resuming and finishing", () => {
    it("a restarted pass takes up only the undecided rows, and an empty queue makes no call", async () => {
      const t = setup(keeping("L1"));
      await t.seed(2);
      await t.pass.sweep();
      expect(t.calls).toEqual([["L1", "L2"]]);
      await t.seed(1, 3);
      const again = t.make();
      await again.sweep();
      expect(t.calls).toEqual([["L1", "L2"], ["L3"]]);
      await t.make().sweep();
      expect(t.calls).toHaveLength(2);
    });

    it("logs done once no row is undecided, and not while a backed-off row waits", async () => {
      const t = setup((links) => {
        if (links.some((l) => l.title === "L1")) throw new Error("garbled");
        return [];
      });
      await t.seed(1);
      await t.pass.sweep();
      expect(t.logged).not.toContain("intent guesses: done");
      for (let i = 0; i < 3; i++) {
        t.advance(10 * MINUTE);
        await t.pass.sweep();
      }
      expect(t.logged.filter((m) => m === "intent guesses: done")).toHaveLength(1);
    });

    it("stops polling once done", async () => {
      vi.useFakeTimers();
      const t = setup();
      await t.seed(1);
      t.pass.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(t.logged).toContain("intent guesses: done");
      expect(vi.getTimerCount()).toBe(0);
    });

    it("stop aborts the call in flight and writes nothing for it", async () => {
      let release: (v: number[]) => void = () => {};
      const t = setup(
        (_links, signal) =>
          new Promise((resolve, reject) => {
            release = resolve;
            signal.addEventListener("abort", () => reject(new Error("aborted")));
          }),
      );
      const [id] = await t.seed(1);
      const sweeping = t.pass.sweep();
      await vi.waitFor(() => expect(t.calls).toHaveLength(1));
      await t.pass.stop();
      release([1]);
      await sweeping;
      expect(t.signals[0]?.aborted).toBe(true);
      expect(await t.held(id as string)).toEqual(["explore", null]);
      expect(t.outcomes()).toEqual({ [id as string]: null });
      expect(t.tries()).toEqual([0]);
    });

    it("writes nothing for a call that answers after stop, though it ignored the abort", async () => {
      let release: (v: number[]) => void = () => {};
      const t = setup(() => new Promise((resolve) => (release = resolve)));
      const [id] = await t.seed(1);
      const sweeping = t.pass.sweep();
      await vi.waitFor(() => expect(t.calls).toHaveLength(1));
      const stopped = t.pass.stop();
      release([1]);
      await Promise.all([sweeping, stopped]);
      expect(await t.held(id as string)).toEqual(["explore", null]);
      expect(t.outcomes()).toEqual({ [id as string]: null });
    });
  });
});
