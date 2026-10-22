import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { addSecondUser, oauthWorld, SECOND_USER, type World } from "../auth/oauth-test-kit.js";
import { manifestSchema, toNewLink } from "../core/export-format.js";
import { copyLimits } from "../core/saved-copy.js";
import type { NewLink } from "../core/types.js";
import { urlKey } from "../core/url-key.js";
import { createDeps } from "../deps.js";
import { FakeEmbedder } from "../search/embedder.js";
import { DIMS } from "../search/model.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const NONCE = "0123456789abcdef0123456789abcdef";
/** Seconds after a fixed start, with a millisecond part that must survive SQLite and JSON. */
const at = (s: number) => new Date(Date.UTC(2026, 9, 1) + s * 1000 + 7);

async function world() {
  const dir = mkdtempSync(join(tmpdir(), "aye-export-routes-"));
  dirs.push(dir);
  const w = await oauthWorld({ savedCopyDir: dir });
  return { w, deps: createDeps(w.links, new FakeEmbedder(DIMS)) };
}

/**
 * One owner's data in every exported collection; every text holds `mark`. Links: active (fetched page,
 * snapshot text), archived, snoozed, bare. Copies: ok, removed in its window, purged. One note removed.
 */
async function seedOwner(
  w: World,
  deps: ReturnType<typeof createDeps>,
  owner: string,
  mark: string,
) {
  const link = (n: number, extra: Partial<NewLink>): NewLink => {
    const url = `https://${mark}.example/${n}`;
    return {
      url,
      urlKey: urlKey(url),
      title: `${mark} "title"\n${n}  🦘`,
      summary: `${mark} summary`,
      summarySource: null,
      why: { text: `${mark} why`, source: "inferred" },
      tags: [
        {
          key: `${mark} space`,
          name: `${mark} Space`,
          source: "stated",
          kind: "project",
          kindSource: "stated",
        },
        {
          key: `${mark} topic`,
          name: `${mark} topic`,
          source: "asked",
          kind: "topic",
          kindSource: "inferred",
        },
      ],
      savedAt: at(n),
      savedBy: `${mark}-agent`,
      lastOpenedAt: at(n + 100),
      lastSurfacedAt: at(n + 200),
      snoozedUntil: null,
      putAwayAt: null,
      tidyKeptAt: null,
      state: "active",
      ...extra,
    };
  };
  const extras: Partial<NewLink>[] = [
    {},
    { state: "archived" },
    { snoozedUntil: at(9_000) },
    { why: null, tags: [], title: null },
  ];
  const ids: string[] = [];
  for (const [i, extra] of extras.entries()) {
    ids.push((await deps.store.insertIfAbsent(owner, link(i + 1, extra))).link.id);
  }
  const [first, second, third] = ids as [string, string, string];
  w.links
    .prepare(
      `UPDATE snapshots SET fetch_status = 'ok', next_fetch_at = NULL, fetched_at = ?, title = ?, text = ? WHERE link_id = ?`,
    )
    .run(at(3).getTime(), `${mark} page title`, `${mark} snapshot body`, Number(first));
  await deps.store.pinTag(owner, `${mark} space`, { pinned: true, color: "teal" });
  await deps.tools.updateToolIf(owner, first, null, {
    status: "kept",
    source: "stated",
    since: at(10),
    answeredAt: null,
    waitDays: 60,
  });
  await deps.checks.updateCheckIf(owner, second, null, {
    checkedAt: at(11),
    result: "dead",
    detail: `http:404 ${mark}`,
    firstDeadAt: at(11),
    flaggedAt: null,
    stillWorksAt: null,
  });
  const ctx = { writtenBy: `${mark}-agent`, at: at(12), focusLimit: 5, purgeBefore: new Date(0) };
  const r = await deps.profile.apply(
    owner,
    {
      addNotes: [
        { text: `${mark} note`, source: "stated" },
        { text: `${mark} removed note`, source: "stated" },
      ],
      editNotes: [],
      removeNotes: [],
      addFocus: [{ text: `${mark} focus`, source: "inferred" }],
    },
    ctx,
  );
  if (!r.ok) throw new Error("seed failed");
  await deps.profile.apply(
    owner,
    {
      addNotes: [],
      editNotes: [],
      addFocus: [],
      removeNotes: [{ id: r.addedNoteIds[1] as string, expectedSource: "stated" }],
    },
    ctx,
  );
  for (const id of [first, second, third]) {
    expect(
      await w.savedCopies.saveCopy(
        owner,
        id,
        { markdown: `${mark} copy`, imageUrls: [], nonce: NONCE },
        copyLimits(1_000_000),
        at(13),
      ),
    ).toBe("saved");
  }
  await w.savedCopies.removeCopy(owner, third, at(14));
  await w.savedCopies.purgeRemoved(at(15));
  await w.savedCopies.removeCopy(owner, second, at(16));
}

const signedIn = async (w: World) => {
  const owner = w.agent();
  await owner.signIn();
  return owner;
};
const parse = (bytes: Buffer) => manifestSchema.parse(JSON.parse(bytes.toString("utf8")));

describe("GET /export.json", () => {
  it("sends the owner's library as a dated, uncached JSON attachment", async () => {
    const { w, deps } = await world();
    await seedOwner(w, deps, "owner", "quokka");
    const res = await (await signedIn(w)).send("/export.json");
    expect(res.status).toBe(200);
    const m = parse(res.bytes);
    expect(Object.fromEntries(res.headers)).toMatchObject({
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "content-disposition": `attachment; filename="aye-links-${m.exportedAt.slice(0, 10)}.json"`,
    });
  });

  it("holds every collection of the owner's, nothing of another owner's, and no snapshot text", async () => {
    const { w, deps } = await world();
    const b = await addSecondUser(w);
    await seedOwner(w, deps, "owner", "quokka");
    await seedOwner(w, deps, SECOND_USER.id, "zebra");
    const sent = {
      quokka: await (await signedIn(w)).send("/export.json"),
      zebra: await b.send("/export.json"),
    };
    for (const [mine, theirs] of [
      ["quokka", "zebra"],
      ["zebra", "quokka"],
    ] as const) {
      const text = sent[mine].bytes.toString("utf8");
      expect(text.toLowerCase()).not.toContain(theirs);
      expect(text).not.toContain(`${mine} snapshot body`);
      const m = parse(sent[mine].bytes);
      expect(m.links.map((l) => [l.url, l.state])).toEqual(
        [1, 2, 3, 4].map((n) => [`https://${mine}.example/${n}`, n === 2 ? "archived" : "active"]),
      );
      expect(m.links[0]?.page).toMatchObject({
        title: `${mine} page title`,
        fetchedAt: at(3).toISOString(),
      });
      expect(m.tags.map((t) => [t.key, t.pinned, t.kind])).toEqual([
        [`${mine} space`, true, "project"],
        [`${mine} topic`, false, "topic"],
      ]);
      expect(m.notes.map((n) => n.text)).toEqual([`${mine} note`]);
      expect(m.focus.map((f) => f.text)).toEqual([`${mine} focus`]);
      expect(m.links.map((l) => l.tool?.status ?? null)).toEqual(["kept", null, null, null]);
      expect(m.links.map((l) => l.check?.detail ?? null)).toEqual([
        null,
        `http:404 ${mine}`,
        null,
        null,
      ]);
      expect(m.links.map((l) => l.copy?.status ?? null)).toEqual([
        "ok",
        "removed",
        "removed",
        null,
      ]);
    }
  });

  it("round-trips every link to the NewLink the store holds, to the millisecond", async () => {
    const { w, deps } = await world();
    await seedOwner(w, deps, "owner", "quokka");
    const m = parse((await (await signedIn(w)).send("/export.json")).bytes);
    const stored = await deps.store.listLinks("owner");
    expect(m.links.map((l) => toNewLink(l, m.tags))).toEqual(
      stored.map(({ id: _id, snapshot: _s, ...rest }) => rest),
    );
  });

  it("sends a browser without a session to /login", async () => {
    const res = await (await world()).w.agent().send("/export.json");
    expect([res.status, res.headers.get("location")]).toEqual([302, "/login"]);
  });

  it("refuses a foreign Origin or Host, and serves a same-site request without an Origin", async () => {
    const owner = await signedIn((await world()).w);
    const foreignOrigin = await owner.send("/export.json", {
      headers: { origin: "https://evil.example" },
    });
    const foreignHost = await owner.send("/export.json", { headers: { host: "evil.example" } });
    expect(foreignOrigin.status).toBe(403);
    expect(foreignHost.status).toBe(403);
    expect((await owner.send("/export.json")).status).toBe(200);
  });
});
