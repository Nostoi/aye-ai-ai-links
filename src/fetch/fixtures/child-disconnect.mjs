process.once("message", () => {
  process.send?.({ type: "received" });
  process.send({ type: "metadata", metadata: { title: "m", description: null, imageUrl: null } });
  process.disconnect();
  setInterval(() => {}, 1000);
});
