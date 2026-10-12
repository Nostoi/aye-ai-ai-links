import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { databasePath, modelRoot, serverConfig } from "./config.js";

describe("modelRoot", () => {
  it("is ~/.aye-links/models", () => {
    expect(modelRoot()).toBe(join(homedir(), ".aye-links", "models"));
  });
});

describe("databasePath", () => {
  it.each([
    {},
    { AYE_DB: "" },
    { AYE_DB: ":memory:" },
    { AYE_DB: "links.db" },
    { AYE_DB: "./data/links.db" },
    { AYE_DB: "~/links.db" },
  ])("refuses %j", (env) => {
    expect(() => databasePath(env)).toThrow(
      "Set AYE_DB to the absolute path of the database file (not :memory:).",
    );
  });

  it("returns the path as given", () => {
    expect(databasePath({ AYE_DB: "/data/links.db" })).toBe("/data/links.db");
  });
});

describe("serverConfig", () => {
  const base = { AYE_DB: "/data/links.db" };

  it("defaults the port to 3002 and leaves allowed hosts unset", () => {
    expect(serverConfig(base)).toEqual({ dbPath: "/data/links.db", port: 3002 });
  });

  it("refuses a missing database like the key CLI does", () => {
    expect(() => serverConfig({})).toThrow("AYE_DB");
  });

  it("reads the port", () => {
    expect(serverConfig({ ...base, AYE_PORT: "8080" }).port).toBe(8080);
  });

  it.each(["abc", "-1", "70000", "1.5", ""])("refuses the port %j", (AYE_PORT) => {
    expect(() => serverConfig({ ...base, AYE_PORT })).toThrow("AYE_PORT");
  });

  it("lower-cases and trims the allowed hosts and adds the loopback names", () => {
    const { allowedHosts } = serverConfig({
      ...base,
      AYE_ALLOWED_HOSTS: " Mac.Tailnet.ts.net , other.example ,",
    });
    expect(allowedHosts).toEqual(["mac.tailnet.ts.net", "other.example", "localhost", "127.0.0.1"]);
  });

  it("leaves allowed hosts unset when the variable is empty", () => {
    expect(serverConfig({ ...base, AYE_ALLOWED_HOSTS: " , " })).not.toHaveProperty("allowedHosts");
  });
});
