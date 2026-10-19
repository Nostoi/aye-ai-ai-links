import type { ChatModel, ModelReply, ModelRequest } from "./model.js";

type Step = ModelReply | Error | ((request: ModelRequest) => ModelReply | Promise<ModelReply>);

/**
 * A model for tests that answers each call with the next step: a reply, an error to throw, or a
 * function of the request. `requests` keeps each request with its messages as they were sent.
 */
export function scriptedModel(
  name: string,
  steps: Step[],
): ChatModel & { requests: ModelRequest[] } {
  const requests: ModelRequest[] = [];
  return {
    name,
    requests,
    async reply(request) {
      requests.push({ ...request, messages: [...request.messages] });
      const step = steps[requests.length - 1];
      if (step === undefined) {
        throw new Error(`The scripted model ${name} has no step ${requests.length}.`);
      }
      if (step instanceof Error) throw step;
      return typeof step === "function" ? step(request) : step;
    },
  };
}
