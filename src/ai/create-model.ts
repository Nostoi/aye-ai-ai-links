import type { AiConfig } from "../config.ts";
import { anthropicModel } from "./anthropic.ts";
import type { ChatModel, Fetch } from "./model.ts";
import { openAiModel } from "./openai.ts";

/** The connector the configured API names. */
export function createChatModel(config: AiConfig, fetchImpl?: Fetch): ChatModel {
  return config.api === "anthropic"
    ? anthropicModel(config, fetchImpl)
    : openAiModel(config, fetchImpl);
}
