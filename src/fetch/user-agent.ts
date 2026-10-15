/** The User-Agent every outgoing fetcher sends: the deployed version, and why the request is made. */
export function userAgent(version: string, purpose: string): string {
  return `aye-ai-ai-links/${version} (personal link library; ${purpose})`;
}
