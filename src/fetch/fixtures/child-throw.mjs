// Test child: fails with an uncaught error while handling the page.
process.once("message", () => {
  throw new Error("boom");
});
