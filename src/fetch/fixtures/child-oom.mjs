// Test child: exhausts its heap, so V8 aborts it with "heap out of memory".
const hold = [];
process.once("message", () => {
  process.send?.({ type: "received" });
  for (;;) hold.push(new Array(100_000).fill(hold.length));
});
