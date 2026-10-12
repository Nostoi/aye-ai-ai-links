// Test child: dies with SIGABRT, but not from the heap limit.
process.once("message", () => {
  process.send?.({ type: "received" }, () => process.abort());
});
