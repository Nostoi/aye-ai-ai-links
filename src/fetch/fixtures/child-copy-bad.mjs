// Test child: sends a copy whose nonce is not a 32-hex string, then exits.
process.once("message", () => {
  process.send?.({ type: "received" });
  process.send?.({
    type: "metadata",
    metadata: { title: "Posted first", description: null, imageUrl: null },
  });
  process.send?.({ type: "text", text: "Kept text" });
  process.send?.({ type: "copy", copy: { markdown: "# x", imageUrls: [], nonce: "x" } }, () =>
    process.exit(0),
  );
});
