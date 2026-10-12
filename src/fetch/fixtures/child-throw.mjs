// Test child: fails with an uncaught error while handling the page.
process.once("message", () => {
  process.send?.({ type: "received" }, () => {
    throw new Error("boom");
  });
});
