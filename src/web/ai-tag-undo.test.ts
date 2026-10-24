import { afterEach, describe, expect, it } from "vitest";
import { runChatTurn, takeTurn } from "../ai/chat-turn.js";
import { scriptedModel } from "../ai/model-test-kit.js";
import { openToolSession, type ToolSession } from "../ai/tool-session.js";
import type { Caller } from "../auth/caller.js";
import { saveLink } from "../core/links.js";
import { createDeps } from "../deps.js";
import { createCallTracker } from "../mcp/call-tracker.js";
import { FakeEmbedder } from "../search/embedder.js";
import { DIMS } from "../search/model.js";
import { openDatabase } from "../store/database.js";
import { chatAnswer } from "./ai-answer.js";

const CALLER: Caller = { owner: "owner-a", savedBy: "In-app AI (Fake)" };
const open: { db: ReturnType<typeof openDatabase>; session?: ToolSession }[] = [];

afterEach(async () => {
  for (const { db, session } of open.splice(0)) {
    await session?.close();
    db.close();
  }
});

async function world() {
  const db = openDatabase(":memory:");
  const deps = createDeps(db, new FakeEmbedder(DIMS));
  deps.store.ensureUser(CALLER.owner, CALLER.owner);
  const entry: (typeof open)[number] = { db };
  open.push(entry);
  for (const [i, tag] of ["Art", "Design"].entries()) {
    await saveLink(deps, CALLER.owner, {
      url: `https://example.com/${i}`,
      savedBy: "x",
      tags: [{ name: tag, source: "stated" }],
    });
  }
  entry.session = await openToolSession(deps, CALLER, createCallTracker().track);
  return { deps, session: entry.session };
}

const calling = (name: string, args: unknown) => ({
  text: "",
  toolCalls: [{ id: "c1", name, arguments: args }],
});

describe("Ask AI and tag merges and deletes", () => {
  it("returns a merge change with the undoId, and the next turn's history carries it", async () => {
    const { deps, session } = await world();
    const model = scriptedModel("Fake", [
      calling("merge_tags", { name: "Art", into: "Design" }),
      { text: "Merged Art into Design. You can undo it for an hour.", toolCalls: [] },
    ]);
    const result = await runChatTurn({
      model,
      session,
      history: [],
      text: "merge art into design",
    });
    const answer = await chatAnswer(deps, CALLER.owner, "Fake", result);

    expect(answer.changes).toEqual([
      { kind: "tag-merge", name: "Art", into: "Design", links: 1, undoId: expect.any(String) },
    ]);
    const undoId = (answer.changes[0] as { undoId: string }).undoId;

    // What the panel stores as the reply and posts back with the next message.
    const next = takeTurn({
      history: [
        { role: "user", text: "merge art into design" },
        { role: "assistant", text: answer.remember },
      ],
      text: "undo that",
    });
    expect(next).not.toBeNull();
    const later = scriptedModel("Fake", [{ text: "ok", toolCalls: [] }]);
    await runChatTurn({ model: later, session, history: next?.history ?? [], text: "undo that" });
    const sent = JSON.stringify(later.requests[0]?.messages);
    expect(sent).toContain(undoId);
    expect(sent).toContain("undo_tag_change");
  });

  it("keeps the undoId in the history of a turn that then failed", async () => {
    const { deps, session } = await world();
    const model = scriptedModel("Fake", [
      calling("delete_tag", { name: "Art" }),
      new Error("never reached"),
    ]);
    const result = await runChatTurn({ model, session, history: [], text: "delete art" });
    expect(result.ok).toBe(false);
    const answer = await chatAnswer(deps, CALLER.owner, "Fake", result);
    expect(answer.changes).toEqual([
      { kind: "tag-delete", name: "Art", links: 1, undoId: expect.any(String) },
    ]);
    const undoId = (answer.changes[0] as { undoId: string }).undoId;
    expect(answer.remember).toContain(undoId);
  });

  it("records a rename, and adds nothing to the history for it or for a plain reply", async () => {
    const { deps, session } = await world();
    const model = scriptedModel("Fake", [
      calling("update_tag", { name: "Art", newName: "Arts" }),
      { text: "Renamed.", toolCalls: [] },
    ]);
    const result = await runChatTurn({ model, session, history: [], text: "rename art" });
    const answer = await chatAnswer(deps, CALLER.owner, "Fake", result);
    expect(answer.changes).toEqual([{ kind: "tag-rename", from: "Art", name: "Arts" }]);
    expect(answer.remember).toBe("Renamed.");
  });
});
