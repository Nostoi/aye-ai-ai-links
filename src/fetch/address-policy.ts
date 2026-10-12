import ipaddr from "ipaddr.js";

const GLOBAL_UNICAST_V6 = ipaddr.parseCIDR("2000::/3");

/**
 * Allowlist: only public unicast addresses pass. IPv4-mapped IPv6 is judged as the IPv4 it carries.
 *
 * ipaddr.js calls any IPv6 address outside its special ranges "unicast", `::7f00:1` (the form of
 * `[::127.0.0.1]`) among them, so IPv6 must also sit inside 2000::/3, the global unicast block.
 */
export function isPublicAddress(ip: string): boolean {
  if (!ipaddr.isValid(ip)) return false;
  const addr = ipaddr.process(ip);
  if (addr.kind() === "ipv4") return addr.range() === "unicast";
  return addr.range() === "unicast" && addr.match(GLOBAL_UNICAST_V6);
}
