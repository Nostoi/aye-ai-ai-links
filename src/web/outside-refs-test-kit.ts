export function outsideRefs(html: string): string[] {
  const markup = html.replace(/(<(script|style)\b[^>]*>)[\s\S]*?(<\/\2>)/gi, "$1$3");
  const tag =
    /<([a-z][\w:-]*)((?:\s+[^\s"'<>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'<>]+))?)*)\s*\/?>/gi;
  const attribute = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>]+)))?/g;
  const outside = /(?:^|[\s,;=(])(?:https?:)?\/\//i;
  const found: string[] = [];
  for (const [, name = "", attributes = ""] of markup.matchAll(tag)) {
    if (name.toLowerCase() === "a") continue;
    for (const [, key = "", ...quoted] of attributes.matchAll(attribute)) {
      const value = quoted.find((v) => v !== undefined) ?? "";
      if (/^(xmlns(:|$)|data-)/i.test(key) || /^\s*data:/i.test(value)) continue;
      if (outside.test(value)) found.push(`<${name} ${key}=${value}>`);
    }
  }
  for (const [, ref = ""] of html.matchAll(/url\(\s*['"]?([^)'"]*)/gi)) {
    if (!/^data:/.test(ref)) found.push(`url(${ref})`);
  }
  if (/@import\b/i.test(html)) found.push("@import");
  return found;
}
