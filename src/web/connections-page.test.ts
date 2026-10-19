import { DOMParser, parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import type { ExportView } from "../core/export-types.js";
import { bookmarkletCode } from "./bookmarklet.js";
import { connectionsPage } from "./connections-page.js";
import { outsideRefs } from "./outside-refs-test-kit.js";
import { escapeHtml } from "./page.js";

const NOW = new Date("2026-10-14T10:00:00Z");
const CODE = bookmarkletCode("https://links.example");
const IDLE: ExportView = { state: "idle" };
const key = (id: number, name: string) => ({
  id,
  name,
  createdAt: new Date("2026-10-10T10:00:00Z"),
  revokedAt: null,
});

type Answer = { status: number; type?: string; body?: unknown; text?: string };
type Sent = { url: string; body: unknown; redirect: unknown };

/** A 302 to `/login` as a `redirect: "manual"` fetch reports it. */
const REDIRECT: Answer = { status: 0, type: "opaqueredirect" };

/**
 * The page in linkedom, with its own script and the Undo bar's run against it. The menu's script
 * is left out. `answer` gives each request's response; every request is recorded.
 */
function load(
  answer: (sent: Sent) => Answer,
  keys = [key(7, "codex"), key(8, "claude")],
  navigator: object = {},
  exportView: ExportView = { state: "idle" },
) {
  const html = connectionsPage({ connections: [], keys, now: NOW, bookmarklet: CODE, exportView });
  const { document, window } = parseHTML(html);
  const code = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .map((m) => m[1] ?? "")
    .filter((s) => !s.includes("sign-out"))
    .join("\n");
  const sent: Sent[] = [];
  const fetch = async (url: string, init?: { body?: string; redirect?: string }) => {
    const request = {
      url,
      body: init?.body === undefined ? undefined : JSON.parse(init.body),
      redirect: init?.redirect,
    };
    sent.push(request);
    const a = answer(request);
    return {
      status: a.status,
      ok: a.status >= 200 && a.status < 300,
      type: a.type ?? "basic",
      text: async () => a.text ?? "",
      json: async () => {
        if (a.body === undefined) throw new SyntaxError("no body");
        return a.body;
      },
    };
  };
  const timers: (() => void)[] = [];
  const setTimer = (fn: () => void) => timers.push(fn);
  const location = { reloads: 0, reload: () => location.reloads++ };
  const onWindow = new Map<string, (event: unknown) => void>();
  new Function(
    "document",
    "fetch",
    "location",
    "navigator",
    "getSelection",
    "addEventListener",
    "setTimeout",
    "clearTimeout",
    "DOMParser",
    code,
  )(
    document,
    fetch,
    location,
    navigator,
    () => ({}),
    (type: string, fn: (event: unknown) => void) => onWindow.set(type, fn),
    setTimer,
    () => {},
    DOMParser,
  );
  const $ = (selector: string) => document.querySelector(selector) as HTMLElement;
  const click = (selector: string) =>
    $(selector).dispatchEvent(new window.Event("click", { bubbles: true }));
  const submit = () =>
    $("#make-key").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  const rows = () =>
    [...document.querySelectorAll("#keys li")].map((li) => (li as HTMLElement).dataset.keyId);
  const settle = () => new Promise((r) => setTimeout(r, 10));
  /** Runs the 5-second timers the script has set so far (not those they set), then lets answers land. */
  const tick = async () => {
    for (const fn of timers.splice(0)) fn();
    await settle();
  };
  /** A window event, such as `pageshow`, sent to what the script registered. */
  const fire = (type: string, event: unknown) => onWindow.get(type)?.(event);
  return { $, click, submit, rows, sent, settle, tick, html, location, fire };
}

const turnOffButton = (id: number) => `li[data-key-id="${id}"] button`;

describe("turning a key off on the page", () => {
  it("posts the key's id at once without following redirects, removes the row, and offers Undo", async () => {
    const page = load(() => ({ status: 204 }));
    page.click(turnOffButton(7));
    await page.settle();
    expect(page.sent).toEqual([
      { url: "/connections/keys/turn-off", body: { id: 7 }, redirect: "manual" },
    ]);
    expect(page.rows()).toEqual(["8"]);
    expect(page.$("#undo-bar").hidden).toBe(false);
    expect(page.$("#undo-bar span").textContent).toBe("Key for codex turned off.");
  });

  it("sends one turn-off while one is pending", async () => {
    const page = load(() => ({ status: 204 }));
    page.click(turnOffButton(7));
    page.click(turnOffButton(7));
    await page.settle();
    expect(page.sent).toHaveLength(1);
  });

  it("Undo posts the same id to turn it back on and puts the row back where it was", async () => {
    const page = load(() => ({ status: 204 }));
    page.click(turnOffButton(7));
    await page.settle();
    page.click("#undo-bar button");
    await page.settle();
    expect(page.sent[1]).toEqual({
      url: "/connections/keys/turn-on",
      body: { id: 7 },
      redirect: "manual",
    });
    expect(page.rows()).toEqual(["7", "8"]);
    expect(page.$("#undo-bar").hidden).toBe(true);
  });

  it.each([
    ["a redirect to the sign-in page", REDIRECT],
    ["a 200 instead of a 204", { status: 200, body: {} }],
  ])("keeps the row and offers no Undo when the turn-off gets %s", async (_, answer) => {
    const page = load(() => answer);
    page.click(turnOffButton(7));
    await page.settle();
    expect(page.rows()).toEqual(["7", "8"]);
    expect(page.$("#undo-bar").hidden).toBe(true);
    expect(page.$("#keys-error").textContent).toMatch(/did not work/);
  });

  it("removes the row and shows the server's message when the turn-off is refused", async () => {
    const page = load(() => ({ status: 400, body: { message: "That key is already off." } }));
    page.click(turnOffButton(7));
    await page.settle();
    expect(page.rows()).toEqual(["8"]);
    expect(page.$("#undo-bar").hidden).toBe(true);
    expect(page.$("#keys-error").textContent).toBe("That key is already off.");
  });

  it.each([
    [
      "refused",
      { status: 400, body: { message: "It's too late to undo." } },
      "It's too late to undo.",
    ],
    ["redirected to sign-in", REDIRECT, "That did not work. Reload the page and try again."],
  ])("leaves the row out when the undo is %s, and says so", async (_, answer, message) => {
    const page = load((sent) => (sent.url.endsWith("turn-off") ? { status: 204 } : answer));
    page.click(turnOffButton(7));
    await page.settle();
    page.click("#undo-bar button");
    await page.settle();
    expect(page.rows()).toEqual(["8"]);
    expect(page.$("#keys-error").textContent).toBe(message);
  });
});

describe("making a key on the page", () => {
  const made = { status: 200, body: { id: 9, name: "<b>Codex</b>", key: "aak_secret" } };

  it("posts the name, shows the key once as text in the amber panel, and adds its row", async () => {
    const page = load(() => made);
    (page.$("#key-name") as HTMLInputElement).value = "<b>Codex</b>";
    page.submit();
    await page.settle();
    expect(page.sent).toEqual([
      { url: "/connections/keys", body: { name: "<b>Codex</b>" }, redirect: "manual" },
    ]);
    expect(page.$("#new-key").hidden).toBe(false);
    expect(page.$("#new-key-value").textContent).toBe("aak_secret");
    expect(page.$("#new-key-name").textContent).toBe("<b>Codex</b>");
    expect(page.$("#new-key").querySelector("b")).toBeNull();
    expect(page.rows()).toEqual(["7", "8", "9"]);
    expect(page.$('li[data-key-id="9"] strong').textContent).toBe("<b>Codex</b>");
    expect((page.$("#key-name") as HTMLInputElement).value).toBe("");
  });

  it("'I copied it' hides the panel and drops the key from the page", async () => {
    const page = load(() => made);
    page.submit();
    await page.settle();
    page.click("#copied-key");
    expect(page.$("#new-key").hidden).toBe(true);
    expect(page.$("#new-key-value").textContent).toBe("");
  });

  it("sends one request while one is pending", async () => {
    const page = load(() => made);
    page.submit();
    page.submit();
    await page.settle();
    expect(page.sent).toHaveLength(1);
  });

  it.each([
    ["a redirect to the sign-in page", REDIRECT, /did not work/],
    ["a 200 without a key", { status: 200, body: { id: 9, name: "x" } }, /did not work/],
    [
      "a refusal",
      { status: 400, body: { message: "Keep the name short." } },
      /Keep the name short/,
    ],
  ])("shows no panel and no new row after %s", async (_, answer, message) => {
    const page = load(() => answer);
    page.submit();
    await page.settle();
    expect(page.$("#new-key").hidden).toBe(true);
    expect(page.$("#new-key-value").textContent).toBe("");
    expect(page.rows()).toEqual(["7", "8"]);
    expect(page.$("#keys-error").textContent).toMatch(message);
  });
});

describe("the page restored from the back-forward cache", () => {
  it("reloads, so the amber panel never comes back", () => {
    const page = load(() => ({ status: 204 }));
    page.fire("pageshow", { persisted: true });
    expect(page.location.reloads).toBe(1);
  });

  it("does not reload on an ordinary page show", () => {
    const page = load(() => ({ status: 204 }));
    page.fire("pageshow", { persisted: false });
    expect(page.location.reloads).toBe(0);
  });
});

describe("the page as served", () => {
  it("lists only keys that are on, with the date they were made, and holds no key", () => {
    const html = connectionsPage({
      connections: [
        { clientId: "c", name: "Claude", connectedAt: new Date("2026-10-13T09:00:00Z") },
      ],
      keys: [key(7, "codex"), { ...key(8, "Retired agent"), revokedAt: NOW }],
      now: NOW,
      bookmarklet: CODE,
      exportView: IDLE,
    });
    expect(html).toContain("Connected October 13");
    expect(html).toContain(
      '<li data-key-id="7"><span><strong>codex</strong><br><span class="small">Made October 10</span>',
    );
    expect(html).not.toContain("Retired agent");
    expect(html).not.toContain('data-key-id="8"');
    expect(html).not.toMatch(/aak_[A-Za-z0-9]/);
    expect(html).toContain('<div class="new-key" id="new-key" role="status" hidden>');
  });
});

describe("Save from your browser", () => {
  const html = connectionsPage({
    connections: [],
    keys: [],
    now: NOW,
    bookmarklet: CODE,
    exportView: IDLE,
  });

  it("offers the bookmarklet as a link to drag and as code to copy, the same code in both, with the phone steps", () => {
    const { document } = parseHTML(html);
    const section = document.querySelector("section[aria-labelledby=bookmarklet-heading]");
    expect(section?.querySelector("h2")?.textContent).toBe("Save from your browser");
    const link = document.getElementById("bookmarklet");
    expect(link?.getAttribute("href")).toBe(CODE);
    expect(link?.textContent).toBe("Save to Aye-AI-AI Links");
    const code = document.getElementById("bookmarklet-code");
    expect(code?.tagName).toBe("TEXTAREA");
    expect(code?.hasAttribute("readonly")).toBe(true);
    // linkedom leaves a textarea's character references undecoded (checked 2026-10-17), so the
    // text a browser shows is pinned in the markup: the code, escaped, as the textarea's whole text.
    expect(html).toContain(`rows="4">${escapeHtml(CODE)}</textarea>`);
    const text = section?.textContent ?? "";
    expect(text).toContain(
      "Drag this to your bookmarks bar. On any page, click it to save that page.",
    );
    expect(text).toContain("iPhone and iPad (Safari):");
    expect(text).toContain("replace its address with the copied code");
    expect(text).toContain("Android (Chrome):");
    expect(text).toContain("type the bookmark's name in the address bar");
  });

  it("comes after Agent keys", () => {
    expect(html.indexOf('id="bookmarklet-heading"')).toBeGreaterThan(
      html.indexOf('id="keys-heading"'),
    );
  });

  it("makes no outside request: the code sits only in the link's href and in element text", () => {
    expect(outsideRefs(html)).toEqual([]);
  });

  it("Copy code copies the field's text and says Copied", async () => {
    const copied: string[] = [];
    const clipboard = {
      writeText: async (text: string) => {
        copied.push(text);
      },
    };
    const page = load(() => ({ status: 204 }), [], { clipboard });
    // Set as a browser decodes it; linkedom would hand back the escaped markup.
    page.$("#bookmarklet-code").textContent = CODE;
    page.click("#copy-bookmarklet");
    await page.settle();
    expect(copied).toEqual([CODE]);
    expect(page.$("#copy-bookmarklet").textContent).toBe("Copied");
  });

  const FAILED = "Copy didn't work. The code is selected: press and hold it, then Copy.";
  const refusing = {
    writeText: async () => {
      throw new Error("denied");
    },
  };

  /** The field as a browser has it: a value, and selection calls recorded. */
  function selectable(page: ReturnType<typeof load>) {
    const calls: unknown[][] = [];
    const field = page.$("#bookmarklet-code") as HTMLElement & Record<string, unknown>;
    field.value = CODE;
    field.select = () => calls.push(["select"]);
    field.setSelectionRange = (...args: unknown[]) => calls.push(["setSelectionRange", ...args]);
    field.focus = () => {};
    return calls;
  }

  it("where the clipboard refuses, selects the whole code and says the copy failed", async () => {
    const page = load(() => ({ status: 204 }), [], { clipboard: refusing });
    const calls = selectable(page);
    expect(page.$("#bookmarklet-status").getAttribute("role")).toBe("status");
    expect(page.$("#bookmarklet-status").textContent).toBe("");
    page.click("#copy-bookmarklet");
    await page.settle();
    expect(calls).toEqual([["select"], ["setSelectionRange", 0, CODE.length]]);
    expect(page.$("#copy-bookmarklet").textContent).toBe("Copy code");
    expect(page.$("#bookmarklet-status").textContent).toBe(FAILED);
  });

  it("where there is no clipboard, selects the code and says the copy failed", async () => {
    const page = load(() => ({ status: 204 }), [], {});
    const calls = selectable(page);
    page.click("#copy-bookmarklet");
    await page.settle();
    expect(calls).toEqual([["select"], ["setSelectionRange", 0, CODE.length]]);
    expect(page.$("#bookmarklet-status").textContent).toBe(FAILED);
  });

  it("each tap shows its own outcome: a refusal after a success ends on Copy code with the status", async () => {
    let refuse = false;
    const clipboard = {
      writeText: async () => {
        if (refuse) throw new Error("denied");
      },
    };
    const page = load(() => ({ status: 204 }), [], { clipboard });
    selectable(page);
    page.click("#copy-bookmarklet");
    await page.settle();
    expect(page.$("#copy-bookmarklet").textContent).toBe("Copied");
    expect(page.$("#bookmarklet-status").textContent).toBe("");
    refuse = true;
    page.click("#copy-bookmarklet");
    await page.settle();
    expect(page.$("#copy-bookmarklet").textContent).toBe("Copy code");
    expect(page.$("#bookmarklet-status").textContent).toBe(FAILED);
    refuse = false;
    page.click("#copy-bookmarklet");
    await page.settle();
    expect(page.$("#copy-bookmarklet").textContent).toBe("Copied");
    expect(page.$("#bookmarklet-status").textContent).toBe("");
  });
});

describe("Your data", () => {
  const view = (exportView: ExportView) =>
    connectionsPage({ connections: [], keys: [], now: NOW, bookmarklet: CODE, exportView });
  const answerBy = (answers: Record<string, Answer | Answer[]>) => (sent: Sent) => {
    const a = answers[sent.url];
    if (a === undefined) throw new Error(`unexpected request ${sent.url}`);
    return Array.isArray(a) ? (a.shift() as Answer) : a;
  };
  const prepare = 'button[data-export="prepare"]';
  const preparing: ExportView = { state: "preparing", startedAt: NOW };

  const VIEWS: [ExportView, RegExp[]][] = [
    [
      { state: "idle" },
      [
        /Download everything you've saved: links, pictures, saved copies and a bookmarks file\./,
        /<button class="primary" type="button" data-export="prepare">Prepare export<\/button>/,
      ],
    ],
    [preparing, [/<p role="status">Preparing your export…<\/p>/]],
    [
      { state: "ready", exportedAt: new Date("2026-10-18T14:05:00Z"), bytes: 1_234_000_000 },
      [
        /<a class="button primary" href="\/export.zip">Download<\/a>/,
        /1\.2 GB, prepared 18 Oct 14:05 UTC\. Kept for 24 hours\./,
        />Prepare again</,
      ],
    ],
    [{ state: "failed", at: NOW }, [/The last export didn't finish\./, />Try again</]],
  ];
  it.each(VIEWS)("shows %o with the links-only JSON under it", (v, shown) => {
    const html = view(v);
    const section = html.slice(html.indexOf('<section id="your-data"'));
    for (const r of shown) expect(section).toMatch(r);
    expect(section).toContain(`data-state="${v.state}"`);
    expect(section).toContain('<a class="button" href="/export.json">Links only (.json)</a>');
    expect(section).toContain('aria-labelledby="your-data-heading"');
    expect(parseHTML(html).document.querySelector("main > section:last-of-type")?.id).toBe(
      "your-data",
    );
    expect(outsideRefs(html)).toEqual([]);
  });

  it("sizes under a GB read in MB, with one decimal", () => {
    const ready = (bytes: number) => view({ state: "ready", exportedAt: NOW, bytes });
    expect(ready(52_400_000)).toContain("52.4 MB, prepared");
    expect(ready(2_000_000_000)).toContain("2.0 GB, prepared");
  });

  it("sizes at the MB/GB edge never read as 1000.0 MB", () => {
    const ready = (bytes: number) => view({ state: "ready", exportedAt: NOW, bytes });
    expect(ready(0)).toContain("0.0 MB, prepared");
    expect(ready(999_949_999)).toContain("999.9 MB, prepared");
    expect(ready(999_999_999)).toContain("1.0 GB, prepared");
    expect(ready(1_000_000_000)).toContain("1.0 GB, prepared");
  });

  it("a non-200 answer from /connections is never swapped in, even with a #your-data in it", async () => {
    const page = load(
      answerBy({
        "/export/prepare": { status: 202 },
        "/connections": { status: 500, text: view({ state: "failed", at: NOW }) },
      }),
      undefined,
      {},
      { state: "idle" },
    );
    page.click(prepare);
    await page.settle();
    expect(page.$("#your-data").dataset.state).toBe("idle");
    expect(page.$("#export-error").textContent).toMatch(/Reload the page/);
  });

  it("Prepare posts once, then swaps in the fresh section from /connections without reloading", async () => {
    const page = load(
      answerBy({
        "/export/prepare": { status: 202 },
        "/connections": { status: 200, text: view(preparing) },
      }),
      undefined,
      {},
      { state: "idle" },
    );
    page.$("#key-name").setAttribute("value", "half-typed");
    page.click(prepare);
    page.click(prepare);
    await page.settle();
    expect(page.sent.map((s) => s.url)).toEqual(["/export/prepare", "/connections"]);
    expect(page.sent.map((s) => s.redirect)).toEqual(["manual", "manual"]);
    expect(page.$("#your-data").dataset.state).toBe("preparing");
    expect(page.$("#your-data").textContent).toContain("Preparing your export…");
    expect(page.location.reloads).toBe(0);
    expect(page.$("#key-name").getAttribute("value")).toBe("half-typed");
  });

  it("while preparing it reads the section again every 5 s and stops once it is ready; Prepare again works after the swap", async () => {
    const ready: ExportView = { state: "ready", exportedAt: NOW, bytes: 5_000_000 };
    const page = load(
      answerBy({
        "/connections": [
          { status: 200, text: view(preparing) },
          { status: 200, text: view(ready) },
          { status: 200, text: view(preparing) },
        ],
        "/export/prepare": { status: 202 },
      }),
      undefined,
      {},
      preparing,
    );
    expect(page.sent).toEqual([]);
    await page.tick();
    expect(page.$("#your-data").dataset.state).toBe("preparing");
    await page.tick();
    expect(page.$("#your-data").dataset.state).toBe("ready");
    await page.tick();
    expect(page.sent.map((s) => s.url)).toEqual(["/connections", "/connections"]);
    page.click(prepare);
    await page.settle();
    expect(page.sent.map((s) => s.url)).toEqual([
      "/connections",
      "/connections",
      "/export/prepare",
      "/connections",
    ]);
  });

  it("a 409 swaps the section too", async () => {
    const page = load(
      answerBy({
        "/export/prepare": { status: 409, body: { code: "already_preparing" } },
        "/connections": { status: 200, text: view(preparing) },
      }),
      undefined,
      {},
      { state: "idle" },
    );
    page.click(prepare);
    await page.settle();
    expect(page.$("#your-data").dataset.state).toBe("preparing");
    expect(page.$("#export-error").textContent).toBe("");
  });

  it("any other answer to Prepare is told to the owner and nothing is swapped", async () => {
    const page = load(answerBy({ "/export/prepare": REDIRECT }), undefined, {}, { state: "idle" });
    page.click(prepare);
    await page.settle();
    expect(page.sent.map((s) => s.url)).toEqual(["/export/prepare"]);
    expect(page.$("#your-data").dataset.state).toBe("idle");
    expect(page.$("#export-error").textContent).toMatch(/Reload the page/);
  });

  it("a sign-in redirect or a page with no #your-data is never swapped in; the owner is told to reload", async () => {
    const page = load(
      answerBy({
        "/export/prepare": { status: 202 },
        "/connections": [REDIRECT, { status: 200, text: "<html>login</html>" }],
      }),
      undefined,
      {},
      { state: "idle" },
    );
    page.click(prepare);
    await page.settle();
    expect(page.$("#your-data").dataset.state).toBe("idle");
    expect(page.$("#export-error").textContent).toMatch(/Reload the page/);
    page.$("#export-error").textContent = "";
    page.click(prepare);
    await page.settle();
    expect(page.$("#your-data").dataset.state).toBe("idle");
    expect(page.$("#export-error").textContent).toMatch(/Reload the page/);
  });
});
