// Entry of the extraction child process; see extract-runner.ts. Posts the page's metadata
// before it starts on the text, so a slow text step cannot take the metadata with it.
import { pageMetadata, pageText, parsePage } from "./extract.ts";

process.once("message", (msg: { html: string; finalUrl: string }) => {
  const send = (m: object) =>
    new Promise<void>((resolve) => {
      process.send?.(m, () => resolve());
    });
  const doc = parsePage(msg.html);
  process.send?.({ type: "metadata", metadata: pageMetadata(doc, msg.finalUrl) });
  const text = pageText(doc);
  void send({ type: "text", text }).then(() => process.exit(0));
});
