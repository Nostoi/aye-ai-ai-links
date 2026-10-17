/** A link's host name, or "" when its URL doesn't parse. */
export const hostOf = (url: string) => {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
};
