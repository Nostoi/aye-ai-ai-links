export type CoreErrorCode = "invalid_url" | "invalid_input" | "not_found" | "conflict";

/** The message is written for an AI agent: say what is wrong and what to try. */
export class CoreError extends Error {
  readonly code: CoreErrorCode;

  constructor(code: CoreErrorCode, message: string) {
    super(message);
    this.name = "CoreError";
    this.code = code;
  }
}
