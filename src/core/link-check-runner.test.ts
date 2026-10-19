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
    errorBackoffMs?: number;
    wrap?: (store: FakeStore) => LinkCheckStore;
    /** Whether the checker can resolve a known name. Default: a fixed answer from `resolverUp`. */
    canResolve?: (signal?: AbortSignal) => Promise<boolean>;
    resolverUp?: boolean;
  } = {},
) {
  const store = new FakeStore();
  const calls: { url: string; wall: number }[] = [];
  let inFlight = 0;
  let most = 0;
  const canResolve = vi.fn(o.canResolve ?? (async () => o.resolverUp ?? true));
  const checker: LinkChecker = {
    canResolve,
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
    ...(o.errorBackoffMs !== undefined && { errorBackoffMs: o.errorBackoffMs }),
  });
  running.push(runner);
  return {
    store,
    runner,
    logged,
    canResolve,
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

  it("asks canResolve once for an ENOTFOUND, and never for a 404, a 200, a timeout or EAI_AGAIN", async () => {
    const outcomes: Record<string, LinkCheckOutcome> = {
      "https://nx.test/": { kind: "network_error", code: "ENOTFOUND" },
      "https://nf.test/": NOT_FOUND,
      "https://ok.test/": okFor("https://ok.test/"),
      "https://slow.test/": { kind: "timeout" },
      "https://again.test/": { kind: "network_error", code: "EAI_AGAIN" },
    };
    const t = setup(async (url) => outcomes[url] as LinkCheckOutcome);
    for (const url of Object.keys(outcomes)) await save(t.store, url);
    await t.runner.sweep();
    expect(t.urls()).toHaveLength(5);
    expect(t.canResolve).toHaveBeenCalledTimes(1);
  });

  it("records a name that doesn't resolve as dead while the resolver is up, flagged by a second dead check a week later", async () => {
    const t = setup(async () => ({ kind: "network_error", code: "ENOTFOUND" }));
    const gone = await save(t.store, "https://gone.test/");
    await t.runner.sweep();
    const first = t.now();
    expect(await t.store.getCheck(OWNER, gone)).toMatchObject({
      checkedAt: first,
      result: "dead",
      detail: "network:ENOTFOUND",
      firstDeadAt: first,
      flaggedAt: null,
    });
    t.advance(7 * DAY);
    await t.runner.sweep();
    expect(await t.store.getCheck(OWNER, gone)).toMatchObject({
      result: "dead",
      firstDeadAt: first,
      flaggedAt: t.now(),
    });
  });

  it("records it as unknown offline, starting no streak, while the resolver is down", async () => {
    const t = setup(async () => ({ kind: "network_error", code: "ENOTFOUND" }), {
      resolverUp: false,
    });
    const gone = await save(t.store, "https://gone.test/");
    await t.runner.sweep();
    expect(await t.store.getCheck(OWNER, gone)).toMatchObject({
      result: "unknown",
      detail: "network:ENOTFOUND:offline",
      firstDeadAt: null,
    });
  });

  it("records a lone name that doesn't resolve as dead, though no other host ever answered", async () => {
    const t = setup(async () => ({ kind: "network_error", code: "ENOTFOUND" }));
    const lone = await save(t.store, "https://lone.test/");
    await t.runner.sweep();
    expect(t.urls()).toEqual(["https://lone.test/"]);
    expect(await t.store.getCheck(OWNER, lone)).toMatchObject({
      result: "dead",
      detail: "network:ENOTFOUND",
    });
  });

  it("on stop while canResolve is pending, writes nothing for that link and stop resolves", async () => {
    const lookup = gate();
    const t = setup(async () => ({ kind: "network_error", code: "ENOTFOUND" }), {
      canResolve: (signal) =>
        new Promise<boolean>((resolve) => {
          signal?.addEventListener("abort", () => resolve(false));
          void lookup.opened.then(() => resolve(true));
        }),
    });
    const id = await save(t.store, "https://gone.test/");
    t.runner.start();
    await waitFor(() => t.canResolve.mock.calls.length === 1);
    await t.runner.stop();
    expect(await t.store.getCheck(OWNER, id)).toBeNull();
    expect((await t.store.dueChecks(checkCutoffs(t.now()), 20)).map((d) => d.linkId)).toEqual([id]);
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

  it("logs a store error and ends that sweep; the timer then waits errorBackoffMs, a clean sweep returns it to pollMs, and an explicit sweep is never throttled", async () => {
    const t = setup(async (url) => okFor(url), { pollMs: 10, errorBackoffMs: 300 });
    const id = await save(t.store, "https://a.test/");
    const due = vi.spyOn(t.store, "dueChecks");
    const write = vi.spyOn(t.store, "updateCheckIf").mockRejectedValueOnce(new Error("disk full"));
    t.runner.start();
    await waitFor(() => t.logged.length > 0);
    expect(t.logged.some((m) => /link check sweep failed/.test(m))).toBe(true);
    expect(due).toHaveBeenCalledTimes(1);
    await new Promise((r) => setTimeout(r, 150));
    expect(due).toHaveBeenCalledTimes(1);
    await t.runner.sweep();
    expect(due).toHaveBeenCalledTimes(2);
    expect(await t.store.getCheck(OWNER, id)).toMatchObject({ result: "alive" });
    expect(write).toHaveBeenCalledTimes(2);
    await waitFor(() => due.mock.calls.length >= 3);
    const afterBackoff = due.mock.calls.length;
    expect(afterBackoff).toBeGreaterThanOrEqual(3);
    await new Promise((r) => setTimeout(r, 100));
    expect(due.mock.calls.length - afterBackoff).toBeGreaterThanOrEqual(3);
  });

  it("on quiesce, a sweep waiting in the request gap ends at once and makes no further request", async () => {
    const t = setup(async (url) => okFor(url), { gapMs: 5_000 });
    await save(t.store, "https://a.test/");
    await save(t.store, "https://b.test/");
    const sweeping = t.runner.sweep();
    await waitFor(() => t.urls().length === 1);
    await new Promise((r) => setTimeout(r, 20));
    const quiesced = performance.now();
    t.runner.quiesce();
    await sweeping;
    expect(performance.now() - quiesced).toBeLessThan(200);
    expect(t.urls()).toEqual(["https://a.test/"]);
  });

  it("never overlaps two sweeps: the second reads what is due only after the first has ended", async () => {
    const release = gate();
    const t = setup(async (url) => {
      await release.opened;
      return okFor(url);
    });
    await save(t.store, "https://a.test/");
    await save(t.store, "https://b.test/");
    const readsSaw: number[] = [];
    const due = t.store.dueChecks.bind(t.store);
    vi.spyOn(t.store, "dueChecks").mockImplementation(async (...args) => {
      readsSaw.push(t.urls().length);
      return due(...args);
    });
    const first = t.runner.sweep();
    const second = t.runner.sweep();
    await waitFor(() => t.urls().length === 1);
    await new Promise((r) => setTimeout(r, 30));
    expect(readsSaw).toEqual([0]);
    release.open();
    await Promise.all([first, second]);
    expect(readsSaw).toEqual([0, 2]);
    expect(t.most()).toBe(1);
  });

  it("survives its link being purged mid-check, and still handles the next link", async () => {
    let doomed = "";
    const t: ReturnType<typeof setup> = setup(async (url) => {
      if (url === "https://a.test/") {
        await t.store.markDeleted(OWNER, doomed, at(0));
        await t.store.purgeDeleted(at(1));
      }
      return okFor(url);
    });
    doomed = await save(t.store, "https://a.test/");
    const next = await save(t.store, "https://b.test/");

    await expect(t.runner.sweep()).resolves.toBeUndefined();
    await expect(t.runner.sweep()).resolves.toBeUndefined();

    expect(t.urls().filter((u) => u === "https://a.test/")).toHaveLength(1);
    expect(await t.store.getCheck(OWNER, next)).toMatchObject({ result: "alive" });
    expect(await t.store.getCheck(OWNER, doomed)).toBeNull();
    expect(t.logged.filter((l) => /fail|error/i.test(l))).toEqual([]);
  });
});
