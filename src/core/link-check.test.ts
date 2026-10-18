import { beforeEach, describe, expect, it } from "vitest";
import type { CoreError } from "./errors.js";
import { FakeStore } from "./fake-store.js";
import type { LinkCheckOutcome } from "./fetch.js";
import {
  applyCheck,
  type CheckVerdict,
  checkCutoffs,
  goneView,
  isGone,
  judgeCheck,
  restoreCheck,
  stillWorks,
} from "./link-check.js";
import type { LinkCheck } from "./link-check-store.js";
import { A, B, newLink } from "./snapshot-store-contract.js";

const DAY = 86_400_000;
const WEEK = 7 * DAY;
const T = new Date("2026-10-01T00:00:00Z");
const t = (ms: number) => new Date(T.getTime() + ms);

const DEAD: CheckVerdict = { result: "dead", detail: "http:404" };
const ALIVE: CheckVerdict = { result: "alive", detail: null };
const UNKNOWN: CheckVerdict = { result: "unknown", detail: "http:503" };

/** The row after these checks, in order, starting from `start` (null: never checked). */
const fold = (steps: [CheckVerdict, Date][], start: LinkCheck | null = null) =>
  steps.reduce<LinkCheck | null>((row, [verdict, at]) => applyCheck(row, verdict, at), start);

const goneRow: LinkCheck = {
  checkedAt: t(WEEK),
  result: "dead",
  detail: "http:404",
  firstDeadAt: T,
  flaggedAt: t(WEEK),
  stillWorksAt: null,
};

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return `${(e as CoreError).code}: ${(e as CoreError).message}`;
  }
  return "no error";
}

describe("judgeCheck", () => {
  const ok = (finalUrl = "https://ex.com/"): LinkCheckOutcome => ({ kind: "ok", finalUrl });
  const http = (status: number): LinkCheckOutcome => ({ kind: "http_error", status });
  const net = (code: string): LinkCheckOutcome => ({ kind: "network_error", code });

  it.each([
    ["a 2xx answer", ok(), true, "alive", null],
    ["a 2xx answer after a redirect", ok("https://ex.com/moved"), true, "alive", null],
    ["a 404", http(404), true, "dead", "http:404"],
    ["a 410", http(410), true, "dead", "http:410"],
    ["ENOTFOUND while the resolver is up", net("ENOTFOUND"), true, "dead", "network:ENOTFOUND"],
    [
      "ENOTFOUND while the resolver is down",
      net("ENOTFOUND"),
      false,
      "unknown",
      "network:ENOTFOUND:offline",
    ],
    ["a 401 login wall", http(401), true, "unknown", "http:401"],
    ["a 403 login wall", http(403), true, "unknown", "http:403"],
    ["a 400", http(400), true, "unknown", "http:400"],
    ["a 405", http(405), true, "unknown", "http:405"],
    ["a 408", http(408), true, "unknown", "http:408"],
    ["a 429", http(429), true, "unknown", "http:429"],
    ["a 451", http(451), true, "unknown", "http:451"],
    ["a 500", http(500), true, "unknown", "http:500"],
    ["a 503", http(503), true, "unknown", "http:503"],
    ["a timeout", { kind: "timeout" }, true, "unknown", "timeout"],
    ["ECONNREFUSED", net("ECONNREFUSED"), true, "unknown", "network:ECONNREFUSED"],
    ["EAI_AGAIN", net("EAI_AGAIN"), true, "unknown", "network:EAI_AGAIN"],
    ["ECONNRESET", net("ECONNRESET"), true, "unknown", "network:ECONNRESET"],
    ["CERT_HAS_EXPIRED", net("CERT_HAS_EXPIRED"), true, "unknown", "network:CERT_HAS_EXPIRED"],
    [
      "a refused address",
      { kind: "refused", reason: "address" },
      true,
      "unknown",
      "refused:address",
    ],
    ["a refused scheme", { kind: "refused", reason: "scheme" }, true, "unknown", "refused:scheme"],
    [
      "too many redirects",
      { kind: "refused", reason: "too_many_redirects" },
      true,
      "unknown",
      "refused:too_many_redirects",
    ],
    [
      "too_large, which the spec's table has no row for",
      { kind: "too_large" },
      true,
      "unknown",
      "too_large",
    ],
  ] as [string, LinkCheckOutcome, boolean, string, string | null][])(
    "judges %s",
    (_, outcome, resolverUp, result, detail) => {
      expect(judgeCheck(outcome, resolverUp)).toEqual({ result, detail });
    },
  );

  it.each([
    ok(),
    http(404),
    http(410),
    http(500),
    { kind: "timeout" },
    net("EAI_AGAIN"),
    net("ECONNREFUSED"),
    { kind: "refused", reason: "address" },
    { kind: "too_large" },
    { kind: "aborted" },
  ] as LinkCheckOutcome[])("judges %j the same whether or not the resolver is up", (outcome) => {
    expect(judgeCheck(outcome, true)).toEqual(judgeCheck(outcome, false));
  });

  it("records nothing for a check aborted by shutdown", () => {
    expect(judgeCheck({ kind: "aborted" }, true)).toBeNull();
  });
});

describe("checkCutoffs", () => {
  it("is now − 7 days for active links and now − 30 days for archived ones", () => {
    expect(checkCutoffs(t(100 * DAY))).toEqual({ active: t(93 * DAY), archived: t(70 * DAY) });
  });
});

describe("applyCheck", () => {
  it("starts a never-checked link's row from the verdict, with the time and detail", () => {
    expect(fold([[ALIVE, T]])).toEqual({
      checkedAt: T,
      result: "alive",
      detail: null,
      firstDeadAt: null,
      flaggedAt: null,
      stillWorksAt: null,
    });
    expect(fold([[DEAD, T]])).toEqual({
      checkedAt: T,
      result: "dead",
      detail: "http:404",
      firstDeadAt: T,
      flaggedAt: null,
      stillWorksAt: null,
    });
  });

  it("flags on a second dead check exactly 7 days after the first, not a millisecond sooner", () => {
    expect(
      fold([
        [DEAD, T],
        [DEAD, t(WEEK - 1)],
      ]),
    ).toMatchObject({ firstDeadAt: T, flaggedAt: null });
    expect(
      fold([
        [DEAD, T],
        [DEAD, t(WEEK)],
      ]),
    ).toMatchObject({ firstDeadAt: T, flaggedAt: t(WEEK) });
  });

  it("flags dead, unknown, dead a week apart: couldn't check doesn't break the streak", () => {
    expect(
      fold([
        [DEAD, T],
        [UNKNOWN, t(3 * DAY)],
        [DEAD, t(WEEK)],
      ]),
    ).toMatchObject({
      result: "dead",
      firstDeadAt: T,
      flaggedAt: t(WEEK),
    });
  });

  it("does not flag dead, alive, dead: one good check ends the streak", () => {
    expect(
      fold([
        [DEAD, T],
        [ALIVE, t(3 * DAY)],
        [DEAD, t(WEEK)],
      ]),
    ).toMatchObject({
      firstDeadAt: t(WEEK),
      flaggedAt: null,
    });
  });

  it("clears a flag on one alive check, and keeps it through an unknown one", () => {
    expect(applyCheck(goneRow, ALIVE, t(2 * WEEK))).toEqual({
      ...goneRow,
      checkedAt: t(2 * WEEK),
      result: "alive",
      detail: null,
      firstDeadAt: null,
      flaggedAt: null,
    });
    expect(applyCheck(goneRow, UNKNOWN, t(2 * WEEK))).toEqual({
      ...goneRow,
      checkedAt: t(2 * WEEK),
      result: "unknown",
      detail: "http:503",
    });
  });

  it("does not flag a dead check stamped before the streak's first one (clock skew)", () => {
    const started: LinkCheck = { ...goneRow, flaggedAt: null, firstDeadAt: t(WEEK) };
    expect(applyCheck(started, DEAD, T)).toMatchObject({ firstDeadAt: t(WEEK), flaggedAt: null });
  });

  it("keeps the first flag time through later dead checks", () => {
    expect(applyCheck(goneRow, DEAD, t(3 * WEEK))).toMatchObject({
      checkedAt: t(3 * WEEK),
      firstDeadAt: T,
      flaggedAt: t(WEEK),
    });
  });

  it("never flags or starts a streak on twenty weekly 403s, a login wall", () => {
    const wall: CheckVerdict = { result: "unknown", detail: "http:403" };
    const steps = Array.from({ length: 20 }, (_, i) => [wall, t(i * WEEK)] as [CheckVerdict, Date]);
    expect(fold(steps)).toMatchObject({ firstDeadAt: null, flaggedAt: null, detail: "http:403" });
  });

  it("drops a dead check that started at or before the owner's It still works, and counts one after", () => {
    const answered: LinkCheck = {
      ...goneRow,
      firstDeadAt: null,
      flaggedAt: null,
      stillWorksAt: t(8 * DAY),
    };
    expect(applyCheck(answered, DEAD, t(8 * DAY - 1))).toMatchObject({
      checkedAt: t(8 * DAY - 1),
      result: "dead",
      firstDeadAt: null,
      flaggedAt: null,
    });
    expect(applyCheck(answered, DEAD, t(8 * DAY))).toMatchObject({ firstDeadAt: null });
    expect(applyCheck(answered, DEAD, t(8 * DAY + 1))).toMatchObject({
      firstDeadAt: t(8 * DAY + 1),
    });
  });
});

describe("isGone", () => {
  it("is true only for a flagged row", () => {
    expect(isGone(null)).toBe(false);
    expect(isGone({ ...goneRow, flaggedAt: null })).toBe(false);
    expect(isGone(goneRow)).toBe(true);
  });
});

describe("goneView", () => {
  it("is null unless flagged, else when it was flagged and last checked", () => {
    expect(goneView(null)).toBeNull();
    expect(goneView({ ...goneRow, flaggedAt: null })).toBeNull();
    expect(goneView(goneRow)).toEqual({ since: goneRow.flaggedAt, checkedAt: goneRow.checkedAt });
  });
});

describe("It still works and its Undo", () => {
  let store: FakeStore;
  let clock: Date;
  const deps = () => ({ store, checks: store, now: () => clock });
  const saved = async (owner = A) => (await store.insertIfAbsent(owner, newLink(1, T))).link.id;
  const put = async (id: string, row: LinkCheck) => {
    await store.updateCheckIf(A, id, await store.getCheck(A, id), row);
  };

  beforeEach(() => {
    store = new FakeStore();
    clock = t(8 * DAY);
  });

  it("clears the flag and the streak, records when, and returns the row written and the row it replaced", async () => {
    const id = await saved();
    await put(id, goneRow);
    const written = { ...goneRow, firstDeadAt: null, flaggedAt: null, stillWorksAt: clock };
    expect(await stillWorks(deps(), A, id)).toEqual({ check: written, previous: goneRow });
    expect(await store.getCheck(A, id)).toEqual(written);
  });

  it("after it, one dead check doesn't flag; a second at least 7 days later does", async () => {
    const id = await saved();
    await put(id, goneRow);
    const { check } = await stillWorks(deps(), A, id);
    const once = applyCheck(check, DEAD, t(9 * DAY));
    expect(once).toMatchObject({ firstDeadAt: t(9 * DAY), flaggedAt: null });
    expect(applyCheck(once, DEAD, t(9 * DAY + WEEK - 1))).toMatchObject({ flaggedAt: null });
    expect(applyCheck(once, DEAD, t(9 * DAY + WEEK))).toMatchObject({
      flaggedAt: t(9 * DAY + WEEK),
    });
  });

  it("is a conflict on a link that isn't flagged, or never checked, and changes nothing", async () => {
    const dead = await saved();
    const unchecked = (await store.insertIfAbsent(A, newLink(2, T))).link.id;
    const notFlagged = { ...goneRow, flaggedAt: null };
    await put(dead, notFlagged);
    const message = "conflict: This link isn't marked as gone. Reload the page.";
    expect(await code(stillWorks(deps(), A, dead))).toBe(message);
    expect(await code(stillWorks(deps(), A, unchecked))).toBe(message);
    expect(await store.getCheck(A, dead)).toEqual(notFlagged);
    expect(await store.getCheck(A, unchecked)).toBeNull();
  });

  it("is not_found for another owner's link and for an id never issued, changing nothing", async () => {
    const id = await saved();
    await put(id, goneRow);
    expect(await code(stillWorks(deps(), B, id))).toMatch(/^not_found: /);
    expect(await code(stillWorks(deps(), A, "no-such-id"))).toMatch(/^not_found: /);
    expect(await store.getCheck(A, id)).toEqual(goneRow);
  });

  it("is a conflict when a check writes the row between its read and its write, leaving the check's row", async () => {
    const id = await saved();
    await put(id, goneRow);
    const checked = applyCheck(goneRow, UNKNOWN, t(8 * DAY - 1));
    const racing = Object.assign(Object.create(store) as FakeStore, {
      updateCheckIf: async (...args: Parameters<FakeStore["updateCheckIf"]>) => {
        await store.updateCheckIf(A, id, goneRow, checked);
        return store.updateCheckIf(...args);
      },
    });
    expect(await code(stillWorks({ ...deps(), checks: racing }, A, id))).toBe(
      "conflict: This link was checked since, so it stays as it is.",
    );
    expect(await store.getCheck(A, id)).toEqual(checked);
  });

  it("Undo puts back the flag, the streak and the earlier stillWorksAt", async () => {
    const id = await saved();
    const earlier = { ...goneRow, stillWorksAt: t(-DAY) };
    await put(id, earlier);
    const change = await stillWorks(deps(), A, id);
    await restoreCheck(deps(), A, id, change.previous, change.check);
    expect(await store.getCheck(A, id)).toEqual(earlier);
  });

  it("Undo after a check in between is a conflict, and the row stays as the check wrote it", async () => {
    const id = await saved();
    await put(id, goneRow);
    const change = await stillWorks(deps(), A, id);
    const checked = applyCheck(change.check, UNKNOWN, t(8 * DAY + 1));
    await put(id, checked);
    expect(await code(restoreCheck(deps(), A, id, change.previous, change.check))).toBe(
      "conflict: This link was checked since, so it stays as it is.",
    );
    expect(await store.getCheck(A, id)).toEqual(checked);
  });

  it.each([
    ["flagged after now", { flaggedAt: t(8 * DAY + 1) }],
    ["flagged with no first dead check", { firstDeadAt: null }],
    ["flagged less than 7 days after the first dead check", { flaggedAt: t(WEEK - 1) }],
    ["with a stillWorksAt after now", { stillWorksAt: t(8 * DAY + 1) }],
    ["with a firstDeadAt after now", { firstDeadAt: t(8 * DAY + 1), flaggedAt: t(8 * DAY + 1) }],
    ["with a checkedAt after now", { checkedAt: t(8 * DAY + 1) }],
    ["with a firstDeadAt that is not a date", { firstDeadAt: new Date(Number.NaN) }],
    ["with a stillWorksAt that is not a date", { stillWorksAt: new Date(Number.NaN) }],
    ["that is not flagged, which It still works never replaces", { flaggedAt: null }],
  ] as [string, Partial<LinkCheck>][])(
    "Undo refuses an earlier row %s, changing nothing",
    async (_, over) => {
      const id = await saved();
      await put(id, goneRow);
      const change = await stillWorks(deps(), A, id);
      const bad = { ...change.previous, ...over };
      expect(await code(restoreCheck(deps(), A, id, bad, change.check))).toMatch(
        /^invalid_input: /,
      );
      expect(await store.getCheck(A, id)).toEqual(change.check);
    },
  );

  it("Undo is not_found for an id never issued", async () => {
    const id = await saved();
    await put(id, goneRow);
    const change = await stillWorks(deps(), A, id);
    expect(
      await code(restoreCheck(deps(), A, "no-such-id", change.previous, change.check)),
    ).toMatch(/^not_found: /);
    expect(await store.getCheck(A, id)).toEqual(change.check);
  });

  it("Undo is not_found for another owner's link", async () => {
    const id = await saved();
    await put(id, goneRow);
    const change = await stillWorks(deps(), A, id);
    expect(await code(restoreCheck(deps(), B, id, change.previous, change.check))).toMatch(
      /^not_found: /,
    );
    expect(await store.getCheck(A, id)).toEqual(change.check);
  });
});
