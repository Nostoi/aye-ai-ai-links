// Entry of the extraction child process; see extract-runner.ts. Says "received" as soon
// as it has the page, then posts the page's metadata before it starts on the text, so a slow text step cannot take the metadata with it.
import { randomBytes } from "node:crypto";
import type { CopyDraft } from "../core/saved-copy.ts";
import { pageArticle, pageMetadata, parsePage } from "./extract.ts";
import { articleMarkdown, copyBase } from "./extract-copy.ts";

process.on("SIGINT", () => {});

process.once("message", (msg: { html: string; finalUrl: string; copy?: boolean }) => {
  const send = (m: object) =>
    new Promise<void>((resolve) => {
      process.send?.(m, () => resolve());
    });
  // Parsing can block the event loop, so it starts only once "received" has been written.
  void send({ type: "received" }).then(() => {
    const doc = parsePage(msg.html);
    const base = copyBase(doc, msg.finalUrl); // before Readability changes the document
    process.send?.({ type: "metadata", metadata: pageMetadata(doc, msg.finalUrl) });
    const { text, article } = pageArticle(doc);
    void send({ type: "text", text }).then(() => {
      if (!msg.copy) return process.exit(0);
      let copy: CopyDraft | null | undefined = null;
      if (article) {
        try {
          copy = articleMarkdown(article, base, randomBytes(16).toString("hex"));
        } catch {
          copy = undefined; // not received: the save goes on without a copy
        }
      }
      if (copy === undefined) return process.exit(0);
      void send({ type: "copy", copy }).then(() => process.exit(0));
    });
  });
});
