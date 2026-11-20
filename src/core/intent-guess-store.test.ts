import { FakeStore } from "./fake-store.js";
import { describeIntentGuessContract } from "./intent-guess-store-contract.js";

describeIntentGuessContract("FakeStore intent guesses", () => {
  const store = new FakeStore();
  return {
    store,
    addOwner: () => {},
    queue: (owner, id) => store.queueGuess(owner, id),
    rows: (owner) => store.guessRows(owner),
  };
});
