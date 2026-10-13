/** Where better-auth and the authorize gate send a browser whose authorization failed. */
export const OAUTH_ERROR_PATH = "/oauth-error";

const GENERIC = "The connection could not be completed. Start it again from the app.";

/**
 * Our own sentence for each OAuth error code we expect. The page shows only these: anyone can
 * link to it with any `error` and `error_description`, so neither is ever shown as written.
 */
const MESSAGES = new Map([
  [
    "invalid_client",
    "This app is not connected, or its details could not be loaded. Start the connection again from the app.",
  ],
  ["invalid_request", "The app sent a request this server cannot accept."],
  ["invalid_scope", "The app asked for access this server does not give."],
  ["access_denied", "The connection was not approved."],
  ["unauthorized_client", "This app may not connect this way."],
  ["unsupported_response_type", "The app asked to connect in a way this server does not support."],
  ["server_error", "Something went wrong on this server. Try again in a few minutes."],
  ["invalid_redirect", "The app asked to return to an address it has not registered."],
]);

/** The sentence to show for an `error` query value; anything unknown gets the generic one. */
export const oauthErrorMessage = (code: string | undefined): string =>
  (code !== undefined && MESSAGES.get(code)) || GENERIC;
