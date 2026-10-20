import { describe, expect, it } from "vitest";
import { oauthWorld } from "../auth/oauth-test-kit.js";
import { saveLink } from "../core/links.js";
import { createDeps } from "../deps.js";
import type { Change } from "../mcp/changes.js";
import { FakeEmbedder } from "../search/embedder.js";
import { DIMS } from "../search/model.js";
import { chatAnswer, MAX_CARDS, tidy } from "./ai-answer.js";

const A = "owner";

/** A's links "Title 1"... and the chat answer for a turn that has seen them all and said `reply(ids)`. */
async function replying(
  count: number,
  reply: (ids: string[]) => string,
  changed: (ids: string[]) => Change[] = () => [],
) {
  const world = await oauthWorld();
  const deps = createDeps(world.links, new FakeEmbedder(DIMS));
  const ids: string[] = [];
  for (let i = 1; i <= count; i++) {
    const { link } = await saveLink(deps, A, {
      url: `https://a.example/${i}`,
      savedBy: "s",
      title: `Title ${i}`,
    });
    ids.push(link.id);
  }
  const answer = await chatAnswer(deps, A, "Fake", {
    ok: true,
    reply: reply(ids),
    changes: changed(ids),
    seen: ids,
  });
  if (!answer.ok) throw new Error("expected an ok answer");
  return { ids, answer };
}
const cardsOf = (segments: ({ text: string } | { card: string })[]) =>
  segments.filter((s) => "card" in s);
const pair = (id: string) => `[[link:${id}]]\nnote ${id}`;

describe("the card cap", () => {
  it("shows MAX_CARDS cards, names the next link in the text, and remembers every marker", async () => {
    expect(MAX_CARDS).toBe(5);
    const { ids, answer } = await replying(6, (all) => all.map(pair).join("\n"));
    expect(cardsOf(answer.segments)).toHaveLength(5);
    expect(JSON.stringify(cardsOf(answer.segments))).not.toContain("Title 6");
    expect(answer.segments.at(-1)).toEqual({
      text: `note ${ids[4]}\nTitle 6\nnote ${ids[5]}`,
    });
    expect(answer.remember).toBe(ids.map(pair).join("\n"));
  });

  it("does not spend a slot on an unseen id or a repeated id", async () => {
    const { answer } = await replying(5, (ids) =>
      ["[[link:999]]", `[[link:${ids[0]}]]`, ...ids.map((id) => `[[link:${id}]]`)].join("\n"),
    );
    expect(cardsOf(answer.segments)).toHaveLength(5);
  });

  it("still gives a card in cards to a changed link named past the cap", async () => {
    const { ids, answer } = await replying(
      6,
      (all) => all.map(pair).join("\n"),
      (all) => [
        {
          kind: "link",
          tool: "save_link",
          linkId: all[5] ?? "",
          created: true,
          fields: [],
          editId: null,
        },
      ],
    );
    expect(cardsOf(answer.segments)).toHaveLength(5);
    expect(Object.keys(answer.cards)).toEqual([ids[5]]);
  });
});

describe("a marker the model mangled", () => {
  it("is not made a card by tidying", async () => {
    const { ids, answer } = await replying(1, () => "[[link:**1**]]");
    expect(ids).toHaveLength(1);
    expect(answer.segments).toEqual([{ text: "[[link:1]]" }]);
  });
});

describe("tidy", () => {
  it.each([
    ["**bold** and **more**", "bold and more"],
    ["a lone ** stays", "a lone ** stays"],
    ["** spaced **", "** spaced **"],
    ["- one", "• one"],
    ["* one", "• one"],
    ["  - nested", "  • nested"],
    ["# Heading", "Heading"],
    ["###### Six", "Six"],
    ["####### Seven", "####### Seven"],
    ["#nospace", "#nospace"],
    ["__init__ and *single* and `code`", "__init__ and *single* and `code`"],
    ["1. first\n2. second", "1. first\n2. second"],
    ["Intro\n-\nnext\n  *\n•", "Intro\nnext"],
  ])("%j -> %j", (input, output) => {
    expect(tidy(input)).toBe(output);
  });
});

describe("tidying the reply", () => {
  it("leaves no segment that is only a bullet where the model wrote '- [[link:ID]] note'", async () => {
    const { answer } = await replying(2, (ids) =>
      ids.map((id) => `- [[link:${id}]] note`).join("\n"),
    );
    expect(answer.segments.map((s) => ("text" in s ? s.text : "card"))).toEqual([
      "card",
      " note",
      "card",
      " note",
    ]);
    expect(answer.remember).not.toMatch(/^[-•]\s*\[\[/m);
  });

  it("tidies the text segments and the remembered text but not the title put in a segment", async () => {
    const world = await oauthWorld();
    const deps = createDeps(world.links, new FakeEmbedder(DIMS));
    const ids: string[] = [];
    for (let i = 1; i <= 6; i++) {
      const { link } = await saveLink(deps, A, {
        url: `https://a.example/${i}`,
        savedBy: "s",
        title: i === 6 ? "**Six** <b>" : `T${i}`,
      });
      ids.push(link.id);
    }
    const reply = `## Found\n**Six** links:\n${ids.map((id) => `[[link:${id}]]`).join("\n")}`;
    const answer = await chatAnswer(deps, A, "Fake", { ok: true, reply, changes: [], seen: ids });
    if (!answer.ok) throw new Error("expected an ok answer");
    expect(answer.segments[0]).toEqual({ text: "Found\nSix links:" });
    expect(answer.segments.at(-1)).toEqual({ text: "**Six** <b>" });
    expect(answer.remember.startsWith("Found\nSix links:\n[[link:")).toBe(true);
  });
});
