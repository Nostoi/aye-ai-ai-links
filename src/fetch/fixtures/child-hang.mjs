// Test child: posts metadata, then blocks forever without returning to its event loop.
process.once("message", () => {
  process.send?.({
    type: "metadata",
    metadata: { title: "Posted first", description: null, imageUrl: null },
  });
  for (;;) {}
});
