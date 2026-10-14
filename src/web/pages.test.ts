import { describe, expect, it } from "vitest";
import type { Link } from "../core/types.js";
import { outsideRefs } from "./outside-refs-test-kit.js";
import {
  connectionsPage,
  consentExpiredPage,
  consentPage,
  homePage,
  loginPage,
  oauthErrorPage,
  searchPage,
} from "./pages.js";

const ORIGIN = "https://links.example";

/** The page's own inline script, run against stand-ins for the DOM, `location` and `fetch`. */
function scriptOf(html: string): string {
  const match = /<script>([\s\S]*?)<\/script>/.exec(html);
  if (!match?.[1]) throw new Error("the page has no inline script");
  return match[1];
}

type Answer = { status: number; body: unknown };

async function run(html: string, search: string, answer: Answer, click?: string) {
  const handlers = new Map<string, (event: { preventDefault: () => void }) => Promise<void>>();
  const element = (id: string) => ({
    id,
    textContent: "",
    value: id === "email" ? "you@example.com" : "pw",
    addEventListener: (_: string, fn: (event: { preventDefault: () => void }) => Promise<void>) =>
      handlers.set(id, fn),
  });
  const elements = new Map<string, ReturnType<typeof element>>();
  const next = /data-next="([^"]*)"/.exec(html)?.[1]?.replaceAll("&amp;", "&");
  const form = Object.assign(element("login"), {
    dataset: { next },
    email: element("email"),
    password: element("pw"),
  });
  elements.set("login", form);
  const document = {
    getElementById: (id: string) => {
      if (!elements.has(id)) elements.set(id, element(id));
      return elements.get(id);
    },
  };
  const location = { search, origin: ORIGIN, href: `${ORIGIN}/page${search}` };
  const sent: { url: string; body: unknown }[] = [];
  const fetch = async (url: string, init: { body: string }) => {
    sent.push({ url, body: JSON.parse(init.body) });
    return {
      ok: answer.status >= 200 && answer.status < 300,
      status: answer.status,
      json: async () => answer.body,
    };
  };
  new Function("document", "location", "fetch", scriptOf(html))(document, location, fetch);
  const handler = handlers.get(click ?? "login");
  if (!handler) throw new Error("the script registered no handler");
  await handler({ preventDefault: () => {} });
  return { location, sent, text: (id: string) => elements.get(id)?.textContent };
}

describe("the login page's script", () => {
  it("follows the url sign-in returns when it resumes an authorization", async () => {
    const signed = "?client_id=c&exp=1&sig=abc";
    const r = await run(loginPage({ next: "/" }), signed, {
      status: 200,
      body: { redirect: true, url: "/consent?client_id=c&sig=abc" },
    });
    expect(r.sent).toEqual([
      {
        url: "/api/auth/sign-in/email",
        body: { email: "you@example.com", password: "pw", oauth_query: signed.slice(1) },
      },
    ]);
    expect(r.location.href).toBe("/consent?client_id=c&sig=abc");
  });

  it("goes to the form's data-next after a sign-in that is not a resume", async () => {
    const next = "/api/auth/oauth2/authorize?client_id=c&state=s";
    const r = await run(loginPage({ next }), "?next=ignored", {
      status: 200,
      body: { redirect: false },
    });
    expect(r.sent[0]?.body).not.toHaveProperty("oauth_query");
    expect(r.location.href).toBe(next);
  });

  it("still follows the returned url on a resume, whatever data-next says", async () => {
    const r = await run(loginPage({ next: "/api/auth/oauth2/authorize?x=1" }), "?sig=abc", {
      status: 200,
      body: { redirect: true, url: "/consent?sig=abc" },
    });
    expect(r.location.href).toBe("/consent?sig=abc");
  });

  it("stays on the page and says so when the password is wrong", async () => {
    const r = await run(loginPage({ next: "/" }), "", { status: 401, body: {} });
    expect(r.location.href).toBe(`${ORIGIN}/page`);
    expect(r.text("error")).toBe("That email and password did not match.");
  });
});

describe("the consent page", () => {
  const query = "client_id=c&redirect_uri=https%3A%2F%2Fclaude.ai%2Fcb&exp=1&sig=abc";

  it.each([
    ["accept", true],
    ["deny", false],
  ])("posts %s with the signed query, then follows the returned url", async (button, accept) => {
    const r = await run(
      consentPage({ clientName: "Claude", redirectHost: "claude.ai" }),
      `?${query}`,
      { status: 200, body: { redirect: true, url: "https://claude.ai/cb?code=1" } },
      button,
    );
    expect(r.sent).toEqual([
      { url: "/api/auth/oauth2/consent", body: { accept, oauth_query: query } },
    ]);
    expect(r.location.href).toBe("https://claude.ai/cb?code=1");
  });

  it("escapes the client's name and host", () => {
    const html = consentPage({ clientName: `<img src=x onerror="1">`, redirectHost: "a&b" });
    expect(html).toContain("&lt;img src=x onerror=&quot;1&quot;&gt;");
    expect(html).toContain("a&amp;b");
    expect(html).not.toContain("<img");
  });
});

const PAGES: [string, string][] = [
  ["login", loginPage({ next: "/" })],
  ["consent", consentPage({ clientName: "Claude", redirectHost: "claude.ai" })],
  ["consent expired", consentExpiredPage()],
  ["connections", connectionsPage([{ clientId: "c", name: "Claude", connectedAt: new Date(0) }])],
  ["error", oauthErrorPage("It failed.")],
  ["home", homePage()],
  ["search", searchPage({ query: "q", links: [], now: new Date(0) })],
];

describe("the outside-request scan", () => {
  it.each([
    ["single-quoted src", "<img src='https://x.example/a.png'>"],
    ["single-quoted link href", "<link rel='preload' href='https://x.example/f.woff2'>"],
    ["unquoted src", "<img src=https://x.example/a.png>"],
    ["unquoted link href", "<link rel=preload href=https://x.example/f.woff2>"],
    ["poster", '<video poster="https://x.example/p.png"></video>'],
    ["second srcset candidate", '<img srcset="/a.png 1x, https://x.example/b.png 2x">'],
    ["object data", '<object data="https://x.example/o.svg"></object>'],
    ["svg image href", '<svg><image href="https://x.example/i.png"/></svg>'],
    ["svg image xlink:href", '<svg><image xlink:href="//x.example/i.png"/></svg>'],
    ["protocol-relative script", '<script src="//x.example/s.js"></script>'],
    ["form action", '<form action="https://x.example/post"></form>'],
    ["meta refresh", '<meta http-equiv="refresh" content="0; url=https://x.example/">'],
    ["css url()", "<style>a{background:url(https://x.example/a.png)}</style>"],
    ["css @import", "<style>@import 'https://x.example/a.css';</style>"],
  ])("flags %s", (_, html) => {
    expect(outsideRefs(html)).not.toEqual([]);
  });

  it("lets navigation links, namespaces and data: values through", () => {
    const html = [
      '<a href="https://claude.ai/cb" target=_blank>go</a>',
      '<svg xmlns="http://www.w3.org/2000/svg"><use href="#m"/></svg>',
      '<link rel="icon" href="data:image/svg+xml,%3Csvg%3E%3C/svg%3E">',
      '<img src="/logo.png" srcset="/a.png 1x, /b.png 2x">',
      '<button data-client-id="https://x.example/id">x</button>',
    ].join("");
    expect(outsideRefs(html)).toEqual([]);
  });
});

describe.each(PAGES)("the %s page", (_, html) => {
  it("makes no outside request", () => {
    expect(outsideRefs(html)).toEqual([]);
  });

  it("carries the theme and a data: favicon", () => {
    expect(html).toContain("prefers-color-scheme: dark");
    expect(html).toMatch(/<link rel="icon" type="image\/svg\+xml" href="data:image\/svg\+xml,/);
  });
});

describe("the header", () => {
  it("links the mark home on signed-in pages only", () => {
    const home = /<a class="brand" href="\/">/;
    expect(homePage()).toMatch(home);
    expect(searchPage({ query: "", links: [], now: new Date(0) })).toMatch(home);
    expect(connectionsPage([])).toMatch(home);
    expect(consentPage({ clientName: "C", redirectHost: "h" })).toMatch(home);
    expect(loginPage({ next: "/" })).not.toMatch(home);
    expect(oauthErrorPage("x")).not.toMatch(home);
  });

  it("labels the logo", () => {
    expect(loginPage({ next: "/" })).toContain('role="img" aria-label="Aye-AI-AI Links"');
  });
});

describe("the menu", () => {
  it("is on home, search and connections, holds only Apps and keys and Sign out, and is not on the others", () => {
    const withMenu = [
      homePage(),
      searchPage({ query: "", links: [], now: new Date(0) }),
      connectionsPage([]),
    ];
    for (const html of withMenu) {
      expect(html).toContain('<a href="/connections">Apps and keys</a>');
      expect(html).toContain('<button id="sign-out"');
      expect(html).not.toMatch(/href="\/(all|tags|profile)"/);
    }
    const without = [loginPage({ next: "/" }), oauthErrorPage("x"), consentExpiredPage()];
    for (const html of without) expect(html).not.toContain('id="sign-out"');
  });
});

/** The home page's script, run with a stand-in for the focused element and the field. */
function pressSlash(active: { tagName: string; isContentEditable?: boolean } | null) {
  let onKey: ((event: Record<string, unknown>) => void) | undefined;
  let focused = 0;
  let prevented = 0;
  const document = {
    activeElement: active,
    getElementById: (id: string) => ({ id, focus: () => focused++ }),
    addEventListener: (type: string, fn: typeof onKey) => {
      if (type === "keydown") onKey = fn;
    },
  };
  new Function("document", scriptOf(homePage()))(document);
  onKey?.({ key: "/", preventDefault: () => prevented++ });
  return { focused, prevented };
}

describe("the home page's / key", () => {
  it("moves focus to the field when nothing is being typed in", () => {
    expect(pressSlash({ tagName: "BODY" })).toEqual({ focused: 1, prevented: 1 });
    expect(pressSlash(null)).toEqual({ focused: 1, prevented: 1 });
  });

  it.each([["INPUT"], ["TEXTAREA"], ["SELECT"]])("leaves a / typed in a %s alone", (tagName) => {
    expect(pressSlash({ tagName })).toEqual({ focused: 0, prevented: 0 });
  });

  it("leaves a / typed in an editable element alone", () => {
    expect(pressSlash({ tagName: "DIV", isContentEditable: true })).toEqual({
      focused: 0,
      prevented: 0,
    });
  });
});

const link = (over: Partial<Link> = {}): Link => ({
  id: "1",
  url: "https://example.com/a",
  urlKey: "example.com/a",
  title: "A title",
  summary: null,
  why: null,
  tags: [],
  savedAt: new Date("2026-03-12T10:00:00Z"),
  savedBy: "claude",
  lastOpenedAt: null,
  lastSurfacedAt: null,
  snoozedUntil: null,
  state: "active",
  snapshot: null,
  ...over,
});
const NOW = new Date("2026-10-14T10:00:00Z");
const results = (links: Link[], query = "battery") => searchPage({ query, links, now: NOW });

describe("the search page's cards", () => {
  it("shows the title as a link that opens in a new tab, the host and the date, and the summary", () => {
    const html = results([link({ summary: "Side-by-side <costs>" })]);
    expect(html).toContain(
      '<a href="https://example.com/a" target="_blank" rel="noopener noreferrer">A title</a>',
    );
    expect(html).toContain("example.com, saved March 12");
    expect(html).toContain("Side-by-side &lt;costs&gt;");
  });

  it("adds the year to a date that is not in the current year", () => {
    expect(results([link({ savedAt: new Date("2025-03-12T10:00:00Z") })])).toContain(
      "saved March 12, 2025",
    );
  });

  it("shows a stated or asked why in quotes, an inferred one as a guess, and none as 'No why yet'", () => {
    const quoted = 'Why: "to compare"';
    expect(results([link({ why: { text: "to compare", source: "stated" } })])).toContain(quoted);
    expect(results([link({ why: { text: "to compare", source: "asked" } })])).toContain(quoted);
    expect(results([link({ why: { text: "outage backup", source: "inferred" } })])).toContain(
      "Why (a guess): outage backup",
    );
    const none = results([link()]);
    expect(none).toContain("No why yet");
    expect(none).toContain('<p class="small">No why yet</p>');
  });

  it("shows a non-web URL as text, not a link", () => {
    const html = results([link({ url: "javascript:alert(1)", title: null })]);
    expect(html).toContain("javascript:alert(1)");
    expect(html).not.toContain('href="javascript:');
  });

  it("escapes the title, the why, the host and the query", () => {
    const html = results(
      [
        link({
          url: "http://a&amp;b.example/x",
          title: "<i>t</i>",
          why: { text: "<u>w</u>", source: "stated" },
        }),
      ],
      '"><script>x',
    );
    expect(html).not.toMatch(/<i>|<u>|<script>x/);
    expect(html).toContain('value="&quot;&gt;&lt;script&gt;x"');
    expect(html).toContain("a&amp;amp;b.example, saved");
  });

  it("shows a stored image from this site, by its versioned URL, and the plain tile otherwise", () => {
    const remote = { status: "ok" as const, fetchedAt: NOW, title: null, description: null };
    const html = searchPage({
      query: "q",
      links: [
        link({ id: "7", snapshot: { ...remote, imageUrl: "https://cdn.example/7.png" } }),
        link({ id: "8", snapshot: { ...remote, imageUrl: "https://cdn.example/8.png" } }),
      ],
      now: NOW,
      images: new Map([["7", "abc123"]]),
    });
    expect(html).toContain('<img class="tile" src="/images/7?v=abc123" alt="" loading="lazy">');
    expect(html.match(/<div class="tile" aria-hidden="true"><\/div>/g)).toHaveLength(1);
    expect(html).not.toContain("cdn.example");
    expect(outsideRefs(html)).toEqual([]);
  });

  it("says when nothing matched, above the 'Not it?' box that links to the newest links", () => {
    const html = results([]);
    expect(html).toContain("Nothing matched");
    expect(html.indexOf("Nothing matched")).toBeLessThan(html.indexOf("Not it?"));
    expect(html).toContain('href="/search?q="');
  });

  it("names the heading by the query: best matches for words, newest for none", () => {
    expect(results([link()], "battery")).toContain("Best matches first");
    expect(results([link()], "  ")).toContain("Your newest links");
    expect(results([link()], "  ")).not.toContain("Best matches first");
  });
});
