import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeStore } from "./fake-store.js";
import { updateLink } from "./links.js";
import type { SnapshotRecord } from "./snapshot-store.js";
import { at, newLink, record } from "./snapshot-store-contract.js";
import {
  createSummaryPass,
  SUMMARY_PAGE_CHARS,
  type Summarizer,
  SummarizerUnavailable,
} from "./summary-pass.js";
import type { SummarySource } from "./types.js";

const OWNER = "o";
const MINUTE = 60_000;

type Page = Parameters<Summarizer["summarize"]>[0];
type Answer = (page: Page, signal: AbortSignal, url: string) => Promise<string> | string;

const running: { stop(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((p) => p.stop()));
  vi.restoreAllMocks();
});

/** A promise settled from outside. */
function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function setup(answer: Answer = (_page, _signal, url) => `About ${url}`) {
  const store = new FakeStore();
  /** The links each call was for, in order. */
  const calls: string[] = [];
  const pages: Page[] = [];
  const signals: AbortSignal[] = [];
  const byTitle = new Map<string, string>();
  const summarizer: Summarizer = {
    summarize: async (page, signal) => {
      const id = byTitle.get(page.title ?? "") ?? "?";
      calls.push(id);
      pages.push(page);
      signals.push(signal);
      return answer(page, signal, id);
    },
  };
  let clock = at(1000).getTime();
  const logged: string[] = [];
  const pass = createSummaryPass({
    store,
    pages: store,
    summarizer,
    now: () => new Date(clock),
    log: (message) => logged.push(message),
    gapMs: 0,
  });
  running.push(pass);
  return {
    store,
    pass,
    calls,
    pages,
    signals,
    logged,
    advance: (ms: number) => {
      clock += ms;
    },
    /** A link with a finished snapshot whose title is its id, holding `summary` if given. */
    async seed(
      n: number,
      summary: [string, SummarySource] | null = null,
      snapshot: Partial<SnapshotRecord> = {},
    ) {
      const { link } = await store.insertIfAbsent(OWNER, newLink(n, at(0)));
      const lease = await store.leaseSnapshot(OWNER, link.id, at(1), at(100));
      const title = `t${link.id}`;
      await store.recordSnapshot(
        OWNER,
        link.id,
        lease?.claim ?? -1,
        record({ title, ...snapshot }),
      );
      byTitle.set(title, link.id);
      if (summary) {
        await store.update(OWNER, link.id, { summary: summary[0], summarySource: summary[1] });
      }
      return link.id;
    },
    held: (id: string) =>
      store.get(OWNER, id).then((l) => [l?.summary ?? null, l?.summarySource ?? null]),
  };
}

describe("summary pass", () => {
  it("writes a server summary for a replaceable link, and a second sweep makes no call", async () => {
    const t = setup(() => "A page about cats");
    const id = await t.seed(1, ["Old", "inferred"]);
    await t.pass.sweep();
    expect(await t.held(id)).toEqual(["A page about cats", "server"]);
    await t.pass.sweep();
    expect(t.calls).toEqual([id]);
  });

  it("summarises a link that has no summary at all", async () => {
    const t = setup(() => "Fresh");
    const id = await t.seed(1);
    await t.pass.sweep();
    expect(await t.held(id)).toEqual(["Fresh", "server"]);
  });

  it("sends the page's title, description and its text capped at SUMMARY_PAGE_CHARS", async () => {
    const t = setup();
    await t.seed(1, null, { description: "About it", text: "x".repeat(SUMMARY_PAGE_CHARS + 50) });
    await t.pass.sweep();
    expect(t.pages).toEqual([
      { title: "tlink-1", description: "About it", text: "x".repeat(SUMMARY_PAGE_CHARS) },
    ]);
  });

  it("leaves alone a link the owner, or the server, already summarised", async () => {
    const t = setup();
    const mine = await t.seed(1, ["Mine", "stated"]);
    const asked = await t.seed(2, ["Asked", "asked"]);
    const done = await t.seed(3, ["Done", "server"]);
    await t.pass.sweep();
    expect(t.calls).toEqual([]);
    expect(await t.held(mine)).toEqual(["Mine", "stated"]);
    expect(await t.held(asked)).toEqual(["Asked", "asked"]);
    expect(await t.held(done)).toEqual(["Done", "server"]);
  });

  it("keeps an owner's edit made during the call", async () => {
    const reply = deferred<string>();
    const t = setup(() => reply.promise);
    const id = await t.seed(1, ["Old", "inferred"]);
    const sweeping = t.pass.sweep();
    await vi.waitFor(() => expect(t.calls).toEqual([id]));
    await updateLink({ store: t.store, now: () => new Date(0) }, OWNER, id, {
      summary: { text: "Mine", source: "stated" },
    });
    reply.resolve("Server's");
    await sweeping;
    expect(await t.held(id)).toEqual(["Mine", "stated"]);
  });

  it("writes nothing for a link deleted during the call, and goes on to the next", async () => {
    const reply = deferred<string>();
    const t = setup((_page, _signal, url) => (url === "link-1" ? reply.promise : "Second"));
    const first = await t.seed(1);
    const second = await t.seed(2);
    const sweeping = t.pass.sweep();
    await vi.waitFor(() => expect(t.calls).toEqual([first]));
    expect(await t.store.markDeleted(OWNER, first, at(5))).toBe(true);
    reply.resolve("First");
    await expect(sweeping).resolves.toBeUndefined();
    expect(t.calls).toEqual([first, second]);
    expect(await t.held(second)).toEqual(["Second", "server"]);
    expect(await t.store.get(OWNER, first)).toBeNull();
  });

  it("one failing link doesn't hold up the others", async () => {
    let failure: () => Error = () => new SummarizerUnavailable("down");
    const t = setup((_page, _signal, url) => {
      if (url === "link-1") throw failure();
      return `For ${url}`;
    });
    const a = await t.seed(1, ["Old", "inferred"]);
    const b = await t.seed(2);
    const c = await t.seed(3);
    await t.pass.sweep();
    expect(await t.held(b)).toEqual(["For link-2", "server"]);
    expect(await t.held(c)).toEqual(["For link-3", "server"]);
    expect(await t.held(a)).toEqual(["Old", "inferred"]);

    failure = () => new Error("reply was empty");
    t.advance(MINUTE);
    await t.pass.sweep();
    expect(t.calls).toEqual([a, b, c, a]);
    expect(await t.held(a)).toEqual(["Old", "inferred"]);
  });

  it("backs a failed link off, doubling, without a cap on tries", async () => {
    const t = setup(() => {
      throw new Error("no");
    });
    const id = await t.seed(1);
    await t.pass.sweep();
    await t.pass.sweep();
    expect(t.calls).toEqual([id]);
    t.advance(MINUTE);
    await t.pass.sweep();
    expect(t.calls).toEqual([id, id]);
    t.advance(MINUTE);
    await t.pass.sweep();
    expect(t.calls).toHaveLength(2);
    t.advance(MINUTE);
    await t.pass.sweep();
    expect(t.calls).toHaveLength(3);
    for (let i = 0; i < 20; i++) {
      t.advance(24 * 60 * MINUTE);
      await t.pass.sweep();
    }
    expect(t.calls).toHaveLength(23);
  });

  it("three failures in a row on different links pause the pass until the pause ends", async () => {
    let failing = true;
    const t = setup((_page, _signal, url) => {
      if (failing) throw new SummarizerUnavailable("down");
      return `For ${url}`;
    });
    for (const n of [1, 2, 3, 4, 5]) await t.seed(n);
    await t.pass.sweep();
    expect(t.calls).toHaveLength(3);
    await t.pass.sweep();
    expect(t.calls).toHaveLength(3);
    t.advance(MINUTE - 1);
    await t.pass.sweep();
    expect(t.calls).toHaveLength(3);

    failing = false;
    t.advance(1);
    await t.pass.sweep();
    expect(t.calls).toHaveLength(8);
    expect(await Promise.all(["link-1", "link-5"].map(t.held))).toEqual([
      ["For link-1", "server"],
      ["For link-5", "server"],
    ]);
  });

  it("doubles the pause while the AI stays down, and a success resets it", async () => {
    let failing = true;
    const t = setup((_page, _signal, url) => {
      if (failing) throw new SummarizerUnavailable("down");
      return `For ${url}`;
    });
    for (const n of [1, 2, 3]) await t.seed(n);
    await t.pass.sweep();
    t.advance(MINUTE);
    await t.pass.sweep();
    expect(t.calls).toHaveLength(4);
    t.advance(MINUTE);
    await t.pass.sweep();
    expect(t.calls).toHaveLength(4);
    t.advance(MINUTE);
    failing = false;
    await t.pass.sweep();
    expect(t.calls.length).toBeGreaterThan(4);

    failing = true;
    for (const n of [4, 5, 6, 7]) await t.seed(n);
    const before = t.calls.length;
    await t.pass.sweep();
    expect(t.calls).toHaveLength(before + 3);
    t.advance(MINUTE);
    await t.pass.sweep();
    expect(t.calls.length).toBeGreaterThan(before + 3);
  });

  it("gives a cleared summary a fresh try", async () => {
    let failing = true;
    const t = setup(() => {
      if (failing) throw new Error("no");
      return "Now";
    });
    const id = await t.seed(1, ["Old", "inferred"]);
    await t.pass.sweep();
    await t.pass.sweep();
    expect(t.calls).toEqual([id]);

    failing = false;
    await updateLink({ store: t.store, now: () => new Date(0) }, OWNER, id, { summary: null });
    await t.pass.sweep();
    expect(t.calls).toEqual([id, id]);
    expect(await t.held(id)).toEqual(["Now", "server"]);
  });

  it("writes nothing for a reply that arrives after stop", async () => {
    const reply = deferred<string>();
    const t = setup(() => reply.promise);
    const id = await t.seed(1, ["Old", "inferred"]);
    const sweeping = t.pass.sweep();
    await vi.waitFor(() => expect(t.calls).toEqual([id]));
    await t.pass.stop();
    reply.resolve("Late");
    await sweeping;
    expect(await t.held(id)).toEqual(["Old", "inferred"]);
  });

  it("aborts the call in flight on stop", async () => {
    const t = setup(
      (_page, signal) =>
        new Promise<string>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    const id = await t.seed(1, ["Old", "inferred"]);
    const sweeping = t.pass.sweep();
    await vi.waitFor(() => expect(t.calls).toEqual([id]));
    expect(t.signals[0]?.aborted).toBe(false);
    await t.pass.stop();
    expect(t.signals[0]?.aborted).toBe(true);
    await sweeping;
    expect(await t.held(id)).toEqual(["Old", "inferred"]);
  });

  it("makes no call once stopped", async () => {
    const t = setup();
    await t.seed(1);
    await t.pass.stop();
    await t.pass.sweep();
    expect(t.calls).toEqual([]);
  });
});
