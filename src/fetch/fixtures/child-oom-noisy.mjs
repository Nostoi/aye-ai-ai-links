process.once("message", () => {
  process.stderr.write("x".repeat(70000) + "\n", () => {
    const h = [];
    for (;;) h.push(new Array(100000).fill(1));
  });
});
