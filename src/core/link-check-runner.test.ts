import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeStore } from "./fake-store.js";
import type { LinkChecker, LinkCheckOutcome } from "./fetch.js";
import { checkCutoffs } from "./link-check.js";
import { createLinkCheckRunner, type LinkCheckRunner } from "./link-check-runner.js";
import type { LinkCheck, LinkCheckStore } from "./link-check-store.js";
import { at, newLink } from "./snapshot-store-contract.js";
import type { LinkState } from "./types.js";

const OWNER = "o";
const DAY = 86_400_000;
const NOT_FOUND: LinkCheckOutcome = { kind: "http_error", status: 404 };
const okFor = (url: string): LinkCheckOutcome => ({ kind: "ok", finalUrl: url });

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

const running: LinkCheckRunner[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((r) => r.stop()));
});

type Answer = (url: string, signal?: AbortSignal) => Promise<LinkCheckOutcome>;

/** A runner over a FakeStore with a fake checker. The clock starts 8 days after `at(0)`, when links are saved. */
function setup(
  answer: Answer,
  o: {
    gapMs?: number;
    hostGapMs?: number;
    pollMs?: number;
    wrap?: (store: FakeStore) => LinkCheckStore;
  } = {},
) {
  const store = new FakeStore();
  const calls: { url: string; wall: number }[] = [];
  let inFlight = 0;
  let most = 0;
  const checker: LinkChecker = {
    check: async (url, signal) => {
      calls.push({ url, wall: performance.now() });
      inFlight++;
      most = Math.max(most, inFlight);
      try {
        return await answer(url, signal);
      } finally {
        inFlight--;
      }
    },
    close: async () => {},
  };
  let clock = at(0).getTime() + 8 * DAY;
  const logged: string[] = [];
  const runner = createLinkCheckRunner({
    checks: o.wrap ? o.wrap(store) : store,
    checker,
    now: () => new Date(clock),
    log: (message) => logged.push(message),
    gapMs: o.gapMs ?? 0,
    hostGapMs: o.hostGapMs ?? 0,
    ...(o.pollMs !== undefined && { pollMs: o.pollMs }),
  });
  running.push(runner);
  return {
    store,
    runner,
    logged,
    urls: () => calls.map((c) => c.url),
    starts: () => calls.map((c) => c.wall),
    most: () => most,
    now: () => new Date(clock),
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

/** A link of OWNER at `url`, saved at `at(0)`. */
async function save(store: FakeStore, url: string, state: LinkState = "active") {
  const { link } = await store.insertIfAbsent(OWNER, {
    ...newLink(0, at(0)),
    url,
    urlKey: url,
    state,
  });
  return link.id;
}

const waitFor = async (pass: () => boolean) => {
  for (let i = 0; i < 200 && !pass(); i++) await new Promise((r) => setTimeout(r, 5));
};

describe("the check runner", () => {
  it("records a due link's verdict, and checks it again only once a week has passed, flagging the second dead check", async () => {
    const t = setup(async () => NOT_FOUND);
    const id = await save(t.store, "https://a.test/1");
    await t.runner.sweep();
    const first = t.now();
    expect(t.urls()).toEqual(["https://a.test/1"]);
    expect(await t.store.getCheck(OWNER, id)).toEqual({
      checkedAt: first,
      result: "dead",
      detail: "http:404",
      firstDeadAt: first,
      flaggedAt: null,
      stillWorksAt: null,
    });
    t.advance(7 * DAY - 1);
    await t.runner.sweep();
    expect(t.urls()).toHaveLength(1);
    t.advance(1);
    await t.runner.sweep();
    expect(t.urls()).toHaveLength(2);
    expect(await t.store.getCheck(OWNER, id)).toMatchObject({
      firstDeadAt: first,
      flaggedAt: t.now(),
    });
  });

  it("checks an archived link monthly", async () => {
    const t = setup(async (url) => okFor(url));
    await save(t.store, "https://a.test/1", "archived");
    t.advance(22 * DAY - 1);
    await t.runner.sweep();
    expect(t.urls()).toEqual([]);
    t.advance(1);
    await t.runner.sweep();
    expect(t.urls()).toHaveLength(1);
    t.advance(30 * DAY - 1);
    await t.runner.sweep();
    expect(t.urls()).toHaveLength(1);
    t.advance(1);
    await t.runner.sweep();
    expect(t.urls()).toHaveLength(2);
  });

  it("never runs more than one check at once", async () => {
    const t = setup(async (url) => {
      await new Promise((r) => setTimeout(r, 2));
      return okFor(url);
    });
    for (const h of ["a", "b", "c"]) await save(t.store, `https://${h}.test/`);
    await t.runner.sweep();
    expect(t.urls()).toHaveLength(3);
    expect(t.most()).toBe(1);
  });

  it("waits gapMs from one request's end to the next one's start", async () => {
    const t = setup(async (url) => okFor(url), { gapMs: 40 });
    for (const h of ["a", "b", "c"]) await save(t.store, `https://${h}.test/`);
    await t.runner.sweep();
    const starts = t.starts();
    expect(starts).toHaveLength(3);
    for (let i = 1; i < starts.length; i++) {
      expect((starts[i] as number) - (starts[i - 1] as number)).toBeGreaterThanOrEqual(35);
    }
  });

  it("skips a host checked within hostGapMs and takes the next due link on another host; the skipped one goes once the gap has passed", async () => {
    const t = setup(async (url) => okFor(url), { hostGapMs: 60_000 });
    await save(t.store, "https://a.test/1");
    await save(t.store, "https://a.test/2");
    await save(t.store, "https://b.test/1");
    await t.runner.sweep();
    expect(t.urls()).toEqual(["https://a.test/1", "https://b.test/1"]);
    t.advance(60_000 - 1);
    await t.runner.sweep();
    expect(t.urls()).toHaveLength(2);
    t.advance(1);
    await t.runner.sweep();
    expect(t.urls()).toEqual(["https://a.test/1", "https://b.test/1", "https://a.test/2"]);
  });

  it("on stop, aborts the check in flight, waits for it, and writes nothing: the link stays due", async () => {
    const events: string[] = [];
    const t = setup(
      (_url, signal) =>
        new Promise<LinkCheckOutcome>((resolve) => {
          events.push("checking");
          signal?.addEventListener("abort", () =>
            setTimeout(() => {
              events.push("aborted");
              resolve({ kind: "aborted" });
            }, 20),
          );
        }),
    );
    const id = await save(t.store, "https://a.test/");
    t.runner.start();
    await waitFor(() => events.includes("checking"));
    await t.runner.stop();
    events.push("stopped");
    expect(events).toEqual(["checking", "aborted", "stopped"]);
    expect(await t.store.getCheck(OWNER, id)).toBeNull();
    expect((await t.store.dueChecks(checkCutoffs(t.now()), 20)).map((d) => d.linkId)).toEqual([id]);
  });

  it("after quiesce, finishes and records the check in flight but starts no other", async () => {
    const release = gate();
    const t = setup(async (url) => {
      await release.opened;
      return okFor(url);
    });
    const first = await save(t.store, "https://a.test/");
    const second = await save(t.store, "https://b.test/");
    const sweeping = t.runner.sweep();
    await waitFor(() => t.urls().length === 1);
    t.runner.quiesce();
    release.open();
    await sweeping;
    expect(t.urls()).toEqual(["https://a.test/"]);
    expect(await t.store.getCheck(OWNER, first)).toMatchObject({ result: "alive" });
    expect(await t.store.getCheck(OWNER, second)).toBeNull();
  });

  it("re-applies its verdict once to the row as the owner changed it during the check", async () => {
    const flagged: LinkCheck = {
      checkedAt: at(0),
      result: "dead",
      detail: "http:404",
      firstDeadAt: new Date(at(0).getTime() - 7 * DAY),
      flaggedAt: at(0),
      stillWorksAt: null,
    };
    let id = "";
    const t = setup(async () => {
      // The owner's It still works, in the same instant the check started.
      await t.store.updateCheckIf(OWNER, id, flagged, {
        ...flagged,
        firstDeadAt: null,
        flaggedAt: null,
        stillWorksAt: t.now(),
      });
      return NOT_FOUND;
    });
    id = await save(t.store, "https://a.test/");
    await t.store.updateCheckIf(OWNER, id, null, flagged);
    await t.runner.sweep();
    expect(await t.store.getCheck(OWNER, id)).toEqual({
      checkedAt: t.now(),
      result: "dead",
      detail: "http:404",
      firstDeadAt: null,
      flaggedAt: null,
      stillWorksAt: t.now(),
    });
  });

  it("records a link that isn't a web address as unknown refused:scheme, never requests it, and leaves it not due", async () => {
    const t = setup(async (url) => okFor(url));
    const id = await save(t.store, "ftp://files.test/a.txt");
    await t.runner.sweep();
    expect(t.urls()).toEqual([]);
    expect(await t.store.getCheck(OWNER, id)).toEqual({
      checkedAt: t.now(),
      result: "unknown",
      detail: "refused:scheme",
      firstDeadAt: null,
      flaggedAt: null,
      stillWorksAt: null,
    });
    expect(await t.store.dueChecks(checkCutoffs(t.now()), 20)).toEqual([]);
  });

  it("a URL that does not parse is handed to the checker and recorded with its refusal, and the sweep goes on", async () => {
    const t = setup(async (url) =>
      url.includes(" ") ? { kind: "refused", reason: "invalid_url" } : okFor(url),
    );
    const bad = await save(t.store, "https://exa mple.com/");
    const next = await save(t.store, "https://b.test/");
    await t.runner.sweep();
    expect(t.urls()).toEqual(["https://exa mple.com/", "https://b.test/"]);
    expect(await t.store.getCheck(OWNER, bad)).toMatchObject({
      result: "unknown",
      detail: "refused:invalid_url",
    });
    expect(await t.store.getCheck(OWNER, next)).toMatchObject({ result: "alive" });
    expect(t.logged).toEqual([]);
  });

  it("records a name that doesn't resolve as dead after another host answered in this sweep", async () => {
    const t = setup(async (url) =>
      url.startsWith("https://up.test") ? okFor(url) : { kind: "network_error", code: "ENOTFOUND" },
    );
    await save(t.store, "https://up.test/");
    const gone = await save(t.store, "https://gone.test/");
    await t.runner.sweep();
    expect(await t.store.getCheck(OWNER, gone)).toMatchObject({
      result: "dead",
      detail: "network:ENOTFOUND",
      firstDeadAt: t.now(),
    });
  });

  it("records it as unconfirmed, starting no streak, when no other host has answered", async () => {
    const t = setup(async () => ({ kind: "network_error", code: "ENOTFOUND" }));
    const gone = await save(t.store, "https://gone.test/");
    const also = await save(t.store, "https://also-gone.test/");
    await t.runner.sweep();
    for (const id of [gone, also]) {
      expect(await t.store.getCheck(OWNER, id)).toMatchObject({
        result: "unknown",
        detail: "network:ENOTFOUND:unconfirmed",
        firstDeadAt: null,
      });
    }
  });

  it("moves on when a link is deleted during its check, writing nothing and logging nothing", async () => {
    let deleted = "";
    const t = setup(async (url) => okFor(url), {
      wrap: (store) =>
        Object.assign(Object.create(store) as FakeStore, {
          updateCheckIf: async (...args: Parameters<FakeStore["updateCheckIf"]>) =>
            args[1] === deleted ? null : store.updateCheckIf(...args),
        }),
    });
    deleted = await save(t.store, "https://a.test/");
    const next = await save(t.store, "https://b.test/");
    await t.runner.sweep();
    expect(t.urls()).toEqual(["https://a.test/", "https://b.test/"]);
    expect(await t.store.getCheck(OWNER, deleted)).toBeNull();
    expect(await t.store.getCheck(OWNER, next)).toMatchObject({ result: "alive" });
    expect(t.logged).toEqual([]);
  });

  it("starts no second sweep while one is running, even when the poll fires", async () => {
    const release = gate();
    const t = setup(
      async (url) => {
        await release.opened;
        return okFor(url);
      },
      { pollMs: 5 },
    );
    const id = await save(t.store, "https://a.test/");
    t.runner.start();
    await new Promise((r) => setTimeout(r, 50));
    expect(t.urls()).toEqual(["https://a.test/"]);
    release.open();
    await new Promise((r) => setTimeout(r, 30));
    expect(t.urls()).toEqual(["https://a.test/"]);
    expect(await t.store.getCheck(OWNER, id)).toMatchObject({ result: "alive" });
  });

  it("logs a store error, ends that sweep, and still runs the next", async () => {
    const t = setup(async (url) => okFor(url));
    const id = await save(t.store, "https://a.test/");
    const write = vi.spyOn(t.store, "updateCheckIf").mockRejectedValueOnce(new Error("disk full"));
    await t.runner.sweep();
    expect(t.logged.some((m) => /link check sweep failed/.test(m))).toBe(true);
    await t.runner.sweep();
    expect(write).toHaveBeenCalledTimes(2);
    expect(await t.store.getCheck(OWNER, id)).toMatchObject({ result: "alive" });
  });
});
