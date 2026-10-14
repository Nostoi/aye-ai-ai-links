import { describe, expect, it } from "vitest";
import { AUTH_BODY_LIMIT } from "../auth/http.js";
import { addSecondUser, oauthWorld, type World } from "../auth/oauth-test-kit.js";
import { addProfile, editProfile, NOTE_UNDO_WINDOW_MS } from "../core/profile.js";
import type { Source } from "../core/types.js";
import { createDeps } from "../deps.js";
import { FakeEmbedder } from "../search/embedder.js";
import { DIMS } from "../search/model.js";
import { outsideRefs } from "./outside-refs-test-kit.js";

const ADD = "/profile/notes/add";
const EDIT = "/profile/notes/edit";
const CONFIRM = "/profile/notes/confirm";
const REMOVE = "/profile/notes/remove";
const RESTORE = "/profile/notes/restore";
const STALE = "An AI changed this note. Reload.";
const GONE = "That note is gone. Reload.";
const XSS = '<img src=x onerror="alert(1)">';

const posting = (json: unknown) => ({ method: "POST", json });

/** Writes a note as an agent would, through core, at `at`; returns its id and the version shown. */
async function agentNote(
  world: World,
  {
    text,
    source,
    by = "Claude",
    owner = "owner",
    at = new Date(),
  }: {
    text: string;
    source: Source;
    by?: string;
    owner?: string;
    at?: Date;
  },
) {
  const deps = { profile: createDeps(world.links, new FakeEmbedder(DIMS)).profile, now: () => at };
  const r = await addProfile(deps, owner, by, { addNotes: [{ text, source }] });
  const id = r.addedNoteIds[0] as string;
  return { id, updatedAt: at.getTime() };
}

/** An agent's later change to the note's text only, a second after `after`. */
async function agentEdit(world: World, id: string, after: number) {
  const deps = {
    profile: createDeps(world.links, new FakeEmbedder(DIMS)).profile,
    now: () => new Date(after + 1000),
  };
  await editProfile(deps, "owner", "Claude", {
    editNotes: [{ id, text: "an AI's newer wording", source: "inferred" }],
  });
}

/** Every profile row of every owner, removed ones included. */
const noteRows = (world: World) =>
  world.links.prepare("SELECT * FROM profile_notes ORDER BY id").all() as Record<string, unknown>[];
const rowOf = (world: World, id: string) => noteRows(world).find((r) => String(r.id) === id);

async function signedIn(world: World) {
  const browser = world.agent();
  await browser.signIn();
  return browser;
}

async function page(world: World) {
  const res = await (await signedIn(world)).send("/profile");
  expect(res.status).toBe(200);
  return String(res.body);
}

describe("the profile page", () => {
  it("sends a browser without a session to /login", async () => {
    const world = await oauthWorld();
    const res = await world.agent().send("/profile");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login");
  });

  it("shows each note with who it came from, and guesses as guesses with a That's right button", async () => {
    const world = await oauthWorld();
    await agentNote(world, { text: "Lives in Austin", source: "stated", by: "Claude" });
    await agentNote(world, { text: "Prefers short steps", source: "asked", by: "ChatGPT" });
    await agentNote(world, { text: "Bakes bread", source: "inferred", by: "Codex" });
    await agentNote(world, { text: "Uses TypeScript", source: "stated", by: "web" });
    const res = await (await signedIn(world)).send("/profile");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const html = String(res.body);
    const card = (text: string) =>
      html.match(new RegExp(`<li[ >](?:(?!</li>).)*${text}(?:(?!</li>).)*</li>`, "s"))?.[0] ?? "";
    expect(card("Lives in Austin")).toContain("You said this to Claude");
    expect(card("Prefers short steps")).toContain("You told ChatGPT when it asked");
    expect(card("Bakes bread")).toContain("A guess by Codex");
    expect(card("Uses TypeScript")).toContain("You confirmed this");
    expect(card("Bakes bread")).toMatch(/class="note guess"/);
    expect(card("Bakes bread")).toMatch(/That(&#39;|')s right/);
    for (const shown of ["Lives in Austin", "Prefers short steps", "Uses TypeScript"]) {
      expect(card(shown)).not.toMatch(/That(&#39;|')s right/);
      expect(card(shown)).not.toContain("guess");
      expect(card(shown)).toContain(">Edit<");
      expect(card(shown)).toContain(">Remove<");
    }
  });

  it("shows what the owner is working on lately, an inferred entry as a guess", async () => {
    const world = await oauthWorld();
    const deps = createDeps(world.links, new FakeEmbedder(DIMS));
    const at = (iso: string) => ({ profile: deps.profile, now: () => new Date(iso) });
    await addProfile(at("2026-10-03T10:00:00Z"), "owner", "ChatGPT", {
      addFocus: [{ text: "Picking countertops", source: "inferred" }],
    });
    await addProfile(at("2026-10-12T10:00:00Z"), "owner", "Claude", {
      addFocus: [{ text: "Researching home batteries", source: "stated" }],
    });
    const html = await page(world);
    expect(html).toContain("Working on lately");
    expect(html.indexOf("Researching home batteries")).toBeLessThan(
      html.indexOf("Picking countertops"),
    );
    expect(html).toMatch(
      /Researching home batteries<\/p><p class="small">October 12, from Claude</,
    );
    expect(html).toMatch(/Picking countertops<\/p><p class="small">October 3, a guess by ChatGPT</);
  });

  it("escapes note text, focus text and the writer's name, and makes no outside request", async () => {
    const world = await oauthWorld();
    const deps = createDeps(world.links, new FakeEmbedder(DIMS));
    await addProfile({ profile: deps.profile, now: () => new Date() }, "owner", XSS, {
      addNotes: [{ text: `note ${XSS}`, source: "inferred" }],
      addFocus: [{ text: `focus ${XSS}`, source: "inferred" }],
    });
    const html = await page(world);
    expect(html).not.toContain("<img");
    expect(html).toContain("note &lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(html).toContain("focus &lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(html).toContain("A guess by &lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(outsideRefs(html)).toEqual([]);
  });

  it("is linked from the menu of every page the owner browses", async () => {
    const world = await oauthWorld();
    const browser = await signedIn(world);
    for (const path of ["/", "/search?q=x", "/connections", "/profile"]) {
      expect(String((await browser.send(path)).body), path).toContain('href="/profile"');
    }
  });

  it.each([
    ["foreign Origin", { origin: "https://evil.example" }],
    ["foreign Host", { host: "evil.example" }],
  ])("refuses GET /profile with a %s, and serves it without", async (_, headers) => {
    const world = await oauthWorld();
    const browser = await signedIn(world);
    expect((await browser.send("/profile", { headers })).status).toBe(403);
    expect((await browser.send("/profile")).status).toBe(200);
  });
});

describe("changing notes on the profile page", () => {
  it("adds a note in the owner's words, stated by the owner, and the page shows it confirmed", async () => {
    const world = await oauthWorld();
    const browser = await signedIn(world);
    const res = await browser.send(ADD, posting({ text: "  Bakes bread on weekends " }));
    expect(res.status).toBe(204);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(noteRows(world)).toMatchObject([
      { owner_id: "owner", text: "Bakes bread on weekends", source: "stated", written_by: "web" },
    ]);
    expect(String((await browser.send("/profile")).body)).toContain("You confirmed this");
  });

  it("adds a note of 1000 four-byte characters, and refuses 1001 with the reason, writing nothing", async () => {
    const world = await oauthWorld();
    const browser = await signedIn(world);
    const longest = "😀".repeat(1000);
    expect((await browser.send(ADD, posting({ text: longest }))).status).toBe(204);
    const before = noteRows(world);
    const res = await browser.send(ADD, posting({ text: `${longest}x` }));
    expect(res.status).toBe(400);
    expect((res.body as { message: string }).message).toMatch(/at most 1000 characters/);
    expect(noteRows(world)).toEqual(before);
  });

  it("confirms a guess with the text shown: it becomes the owner's, stated", async () => {
    const world = await oauthWorld();
    const n = await agentNote(world, { text: "Bakes bread", source: "inferred" });
    const res = await (await signedIn(world)).send(CONFIRM, posting({ ...n, text: "Bakes bread" }));
    expect(res.status).toBe(204);
    expect(rowOf(world, n.id)).toMatchObject({
      text: "Bakes bread",
      source: "stated",
      written_by: "web",
    });
  });

  it("edits a note to the owner's text, stated, and refuses blank text with the reason", async () => {
    const world = await oauthWorld();
    const n = await agentNote(world, { text: "Lives in York", source: "asked" });
    const browser = await signedIn(world);
    const blank = await browser.send(EDIT, posting({ ...n, text: "  " }));
    expect(blank.status).toBe(400);
    expect((blank.body as { message: string }).message).toMatch(/cannot be blank/);
    const res = await browser.send(EDIT, posting({ ...n, text: "Lives in Leeds" }));
    expect(res.status).toBe(204);
    expect(rowOf(world, n.id)).toMatchObject({
      text: "Lives in Leeds",
      source: "stated",
      written_by: "web",
    });
  });

  it("removes a note at once: it leaves the page and every agent's view, and Undo brings it back as it was", async () => {
    const world = await oauthWorld();
    const n = await agentNote(world, { text: "Bakes bread", source: "inferred" });
    const before = rowOf(world, n.id);
    const browser = await signedIn(world);
    const res = await browser.send(REMOVE, posting(n));
    expect(res.status).toBe(204);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(String((await browser.send("/profile")).body)).not.toContain("Bakes bread");
    const deps = createDeps(world.links, new FakeEmbedder(DIMS));
    expect((await deps.profile.listNotes("owner")).map((x) => x.id)).not.toContain(n.id);
    const back = await browser.send(RESTORE, posting({ id: n.id }));
    expect(back.status).toBe(204);
    expect(rowOf(world, n.id)).toEqual(before);
    expect(String((await browser.send("/profile")).body)).toContain("Bakes bread");
  });

  it("refuses an Undo more than a minute after the removal: the note is purged, the others stay", async () => {
    const world = await oauthWorld();
    const n = await agentNote(world, { text: "Bakes bread", source: "inferred" });
    await agentNote(world, { text: "Lives in Leeds", source: "stated" });
    const browser = await signedIn(world);
    await browser.send(REMOVE, posting(n));
    world.links
      .prepare("UPDATE profile_notes SET removed_at = removed_at - ? WHERE id = ?")
      .run(NOTE_UNDO_WINDOW_MS + 1000, Number(n.id));
    const others = noteRows(world).filter((r) => String(r.id) !== n.id);
    const res = await browser.send(RESTORE, posting({ id: n.id }));
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ code: "not_found", message: GONE });
    expect(noteRows(world)).toEqual(others);
    expect(String((await browser.send("/profile")).body)).not.toContain("Bakes bread");
  });

  describe.each([
    [CONFIRM, (n: { id: string; updatedAt: number }) => ({ ...n, text: "Bakes bread" })],
    [EDIT, (n: { id: string; updatedAt: number }) => ({ ...n, text: "Owner's words" })],
    [REMOVE, (n: { id: string; updatedAt: number }) => n],
  ])("POST %s", (path, body) => {
    it("answers 409 when an AI changed the note since the page showed it, and the row is unchanged", async () => {
      const world = await oauthWorld();
      const n = await agentNote(world, { text: "Bakes bread", source: "inferred" });
      await agentEdit(world, n.id, n.updatedAt);
      const before = noteRows(world);
      const res = await (await signedIn(world)).send(path, posting(body(n)));
      expect(res.status).toBe(409);
      expect(res.body).toEqual({ code: "conflict", message: STALE });
      expect(noteRows(world)).toEqual(before);
    });

    it("answers 404 for a note that is gone, and changes nothing", async () => {
      const world = await oauthWorld();
      const n = await agentNote(world, { text: "Bakes bread", source: "inferred" });
      const browser = await signedIn(world);
      await browser.send(REMOVE, posting(n));
      const before = noteRows(world);
      for (const id of [n.id, "9999"]) {
        const res = await browser.send(path, posting(body({ ...n, id })));
        expect(res.status, id).toBe(404);
        expect(res.body).toEqual({ code: "not_found", message: GONE });
      }
      expect(noteRows(world)).toEqual(before);
    });
  });
});

describe("two owners on the profile page", () => {
  /** A's live guess and a guess A removed just now, which Undo could still bring back. */
  async function twoOwners() {
    const world = await oauthWorld();
    const live = await agentNote(world, { text: "A's guess", source: "inferred" });
    const gone = await agentNote(world, { text: "A's removed guess", source: "inferred" });
    const a = await signedIn(world);
    expect((await a.send(REMOVE, posting(gone))).status).toBe(204);
    const b = await addSecondUser(world);
    const aRows = () =>
      world.links.prepare("SELECT * FROM profile_notes WHERE owner_id = 'owner' ORDER BY id").all();
    return { world, live, gone, a, b, aRows };
  }

  it("B's page shows none of A's notes, and B's add is B's own", async () => {
    const { world, b, aRows } = await twoOwners();
    const before = aRows();
    expect(String((await b.send("/profile")).body)).not.toContain("A&#39;s");
    expect((await b.send(ADD, posting({ text: "B's note" }))).status).toBe(204);
    expect(aRows()).toEqual(before);
    expect(
      world.links.prepare("SELECT text FROM profile_notes WHERE owner_id = 'owner-b'").all(),
    ).toEqual([{ text: "B's note" }]);
  });

  it.each([
    [CONFIRM, "live", { text: "hijack" }],
    [EDIT, "live", { text: "hijack" }],
    [REMOVE, "live", {}],
    [RESTORE, "gone", {}],
  ] as const)(
    "B's POST %s with A's note and version answers as for no note, and A's rows stay",
    async (path, which, extra) => {
      const { live, gone, a, b, aRows } = await twoOwners();
      const note = which === "live" ? live : gone;
      const send = (id: string) =>
        b.send(path, posting(path === RESTORE ? { id } : { ...note, id, ...extra }));
      const before = aRows();
      const theirs = await send(note.id);
      const none = await send("9999");
      expect(theirs.status).toBe(404);
      expect(theirs.bytes.equals(none.bytes)).toBe(true);
      expect(aRows()).toEqual(before);
      // The same request is A's to make, so B's refusal was about whose note it is.
      expect(
        (await a.send(path, posting(path === RESTORE ? { id: note.id } : { ...note, ...extra })))
          .status,
      ).toBe(204);
    },
  );
});

describe("refused profile writes", () => {
  const OVER = "x".repeat(AUTH_BODY_LIMIT);
  /** A live guess and one removed just now, so every POST has a body that would succeed. */
  async function notesWorld() {
    const world = await oauthWorld();
    const live = await agentNote(world, { text: "A guess", source: "inferred" });
    const gone = await agentNote(world, { text: "Removed", source: "inferred" });
    await (await signedIn(world)).send(REMOVE, posting(gone));
    return { world, live, gone };
  }
  type Notes = Awaited<ReturnType<typeof notesWorld>>;

  describe.each([
    [ADD, () => ({ text: "New note" })],
    [CONFIRM, ({ live }: Notes) => ({ ...live, text: "A guess" })],
    [EDIT, ({ live }: Notes) => ({ ...live, text: "Owner's words" })],
    [REMOVE, ({ live }: Notes) => live],
    [RESTORE, ({ gone }: Notes) => ({ id: gone.id })],
  ] as const)("POST %s", (path, sample) => {
    const wrongTypes: [string, (json: Record<string, unknown>) => object][] = Object.keys(
      path === ADD
        ? { text: 1 }
        : path === RESTORE
          ? { id: 1 }
          : path === REMOVE
            ? { id: 1, updatedAt: 1 }
            : { id: 1, updatedAt: 1, text: 1 },
    ).flatMap((key) => [
      [`with ${key} missing`, (json) => ({ json: { ...json, [key]: undefined } })],
      [
        `with ${key} of the wrong type`,
        (json) => ({ json: { ...json, [key]: key === "updatedAt" ? String(json[key]) : 7 } }),
      ],
      ...(key === "updatedAt"
        ? ([
            [
              "with a fractional updatedAt",
              (json: Record<string, unknown>) => ({
                json: { ...json, updatedAt: Number(json.updatedAt) + 0.5 },
              }),
            ],
          ] as [string, (json: Record<string, unknown>) => object][])
        : []),
    ]);
    const refusals: [string, (json: Record<string, unknown>) => object, number][] = [
      ["without an Origin", (json) => ({ json, origin: false }), 403],
      [
        "with a foreign Origin",
        (json) => ({ json, headers: { origin: "https://evil.example" } }),
        403,
      ],
      ["with a foreign Host", (json) => ({ json, headers: { host: "evil.example" } }), 403],
      ["without a session", (json) => ({ json, anonymous: true }), 302],
      ["with a body over the cap", (json) => ({ json: { ...json, pad: OVER } }), 413],
      [
        "with a body over the cap, before reading any session",
        (json) => ({ json: { ...json, pad: OVER }, anonymous: true }),
        413,
      ],
      [
        "with a body that is not JSON",
        (json) => ({ rawForm: new URLSearchParams(json as Record<string, string>).toString() }),
        400,
      ],
      ...wrongTypes.map(
        ([name, how]) =>
          [name, how, 400] as [string, (json: Record<string, unknown>) => object, number],
      ),
    ];

    it.each(refusals)("refuses a request %s, and every note row stays", async (_, how, status) => {
      const w = await notesWorld();
      const before = noteRows(w.world);
      const { anonymous, ...options } = how(sample(w) as Record<string, unknown>) as {
        anonymous?: true;
      };
      const browser = anonymous ? w.world.agent() : await signedIn(w.world);
      const res = await browser.send(path, { method: "POST", ...options });
      expect(res.status).toBe(status);
      expect(noteRows(w.world)).toEqual(before);
    });

    it("succeeds with the same body from a signed-in page, so each refusal is down to what it changed", async () => {
      const w = await notesWorld();
      const res = await (await signedIn(w.world)).send(path, posting(sample(w)));
      expect(res.status).toBe(204);
    });
  });
});
