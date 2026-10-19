// Test child: sends received, metadata and text, says so on stderr, then blocks forever.
process.once("message", () => {
  process.send?.({ type: "received" });
  process.send?.({
    type: "metadata",
    metadata: { title: "Posted first", description: null, imageUrl: null, iconUrls: [] },
  });
  process.send?.({ type: "text", text: "Kept text" }, () => {
    process.stderr.write("text-sent\n");
    for (;;) {}
  });
});
