import { describe, expect, it } from "vitest";
import { isPublicAddress } from "./address-policy.js";

const refused = [
  "127.0.0.1",
  "10.1.2.3",
  "172.16.0.1",
  "192.168.1.1",
  "100.64.0.1",
  "100.100.100.100",
  "169.254.169.254",
  "0.0.0.0",
  "224.0.0.1",
  "255.255.255.255",
  "::1",
  "::",
  "fe80::1",
  "fc00::1",
  "fd7a:115c:a1e0::1",
  "::ffff:127.0.0.1",
  "::ffff:7f00:1",
  "::ffff:169.254.169.254",
  "::127.0.0.1",
  "::7f00:1",
  "64:ff9b::7f00:1",
  "2002:7f00:1::",
  "ff02::1",
  "2001:db8::1",
  "not an address",
  "",
];

const allowed = ["8.8.8.8", "93.184.215.14", "2606:4700::1111", "::ffff:8.8.8.8"];

describe("isPublicAddress", () => {
  it.each(refused)("refuses %j", (ip) => {
    expect(isPublicAddress(ip)).toBe(false);
  });

  it.each(allowed)("allows %s", (ip) => {
    expect(isPublicAddress(ip)).toBe(true);
  });

  it("refuses the address the URL parser makes of http://[::127.0.0.1]/", () => {
    const host = new URL("http://[::127.0.0.1]/").hostname;
    expect(host).toBe("[::7f00:1]");
    expect(isPublicAddress(host.slice(1, -1))).toBe(false);
  });
});
