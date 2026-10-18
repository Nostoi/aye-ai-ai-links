import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  appVersion,
  authConfig,
  databasePath,
  modelRoot,
  savedCopyConfig,
  serverConfig,
  VERSION_FILE,
} from "./config.js";

describe("modelRoot", () => {
  it("is ~/.aye-links/models", () => {
    expect(modelRoot()).toBe(join(homedir(), ".aye-links", "models"));
  });
});

describe("appVersion", () => {
  let dir = "";
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = "";
  });
  const fresh = () => {
    dir = mkdtempSync(join(tmpdir(), "aye-version-"));
    return join(dir, "VERSION");
  };

  it("reads VERSION at the package root, beside src/ and dist/", () => {
    expect(fileURLToPath(VERSION_FILE)).toBe(join(process.cwd(), "VERSION"));
  });

  it("returns the file's version without its newline", () => {
    const file = fresh();
    writeFileSync(file, "v2026.10.14.2\n");
    expect(appVersion(file)).toBe("v2026.10.14.2");
  });

  it("is dev when the file is missing", () => {
    expect(appVersion(fresh())).toBe("dev");
  });

  it("refuses an empty file", () => {
    const file = fresh();
    writeFileSync(file, "\n");
    expect(() => appVersion(file)).toThrow("is empty");
  });

  it("refuses a file it cannot read, rather than reporting dev", () => {
    const file = fresh();
    mkdirSync(file);
    expect(() => appVersion(file)).toThrow(/EISDIR/);
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

const SECRET = "s".repeat(32);
const AUTH = {
  AYE_DB: "/data/links.db",
  AYE_AUTH_DB: "/data/auth.db",
  AYE_AUTH_SECRET: SECRET,
  AYE_BASE_URL: "https://mac.tailnet.ts.net:8444",
};

describe("authConfig", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const scratch = () => {
    const d = mkdtempSync(join(tmpdir(), "aye-config-"));
    dirs.push(d);
    return d;
  };

  it("reads the three settings", () => {
    expect(authConfig(AUTH)).toEqual({
      dbPath: "/data/auth.db",
      secret: SECRET,
      baseUrl: "https://mac.tailnet.ts.net:8444",
    });
  });

  it.each([undefined, "", ":memory:", "auth.db", "~/auth.db"])(
    "refuses the auth database %j",
    (AYE_AUTH_DB) => {
      expect(() => authConfig({ ...AUTH, AYE_AUTH_DB })).toThrow(
        "Set AYE_AUTH_DB to the absolute path of the auth database file (not :memory:).",
      );
    },
  );

  it.each([undefined, "", "s".repeat(31)])("refuses the secret %j", (AYE_AUTH_SECRET) => {
    expect(() => authConfig({ ...AUTH, AYE_AUTH_SECRET })).toThrow(
      "Set AYE_AUTH_SECRET to a random string of at least 32 characters.",
    );
  });

  it("accepts a secret of exactly 32 characters", () => {
    expect(authConfig({ ...AUTH, AYE_AUTH_SECRET: "x".repeat(32) }).secret).toBe("x".repeat(32));
  });

  it.each([
    undefined,
    "",
    "http://mac.tailnet.ts.net",
    "https://mac.tailnet.ts.net/",
    "https://mac.tailnet.ts.net/app",
    "https://mac.tailnet.ts.net?x=1",
    "https://user@mac.tailnet.ts.net",
    "mac.tailnet.ts.net",
  ])("refuses the base URL %j", (AYE_BASE_URL) => {
    expect(() => authConfig({ ...AUTH, AYE_BASE_URL })).toThrow(
      "Set AYE_BASE_URL to the https origin the browser uses, such as https://links.example.com, with no path or trailing slash.",
    );
  });

  it("needs AYE_DB, so it can tell the two files apart", () => {
    const { AYE_DB: _, ...noDb } = AUTH;
    expect(() => authConfig(noDb)).toThrow("AYE_DB");
  });

  it("refuses the same path for both databases", () => {
    expect(() => authConfig({ ...AUTH, AYE_AUTH_DB: "/data/links.db" })).toThrow(
      "AYE_AUTH_DB must be a different file from AYE_DB.",
    );
  });

  it("refuses a path that only differs by . or ..", () => {
    expect(() => authConfig({ ...AUTH, AYE_AUTH_DB: "/data/x/../links.db" })).toThrow(
      "AYE_AUTH_DB must be a different file from AYE_DB.",
    );
  });

  it("refuses a symlink to the links database", () => {
    const d = scratch();
    writeFileSync(join(d, "links.db"), "");
    symlinkSync(join(d, "links.db"), join(d, "auth.db"));
    expect(() =>
      authConfig({ ...AUTH, AYE_DB: join(d, "links.db"), AYE_AUTH_DB: join(d, "auth.db") }),
    ).toThrow("AYE_AUTH_DB must be a different file from AYE_DB.");
  });

  it("refuses a hard link to the links database", () => {
    const d = scratch();
    writeFileSync(join(d, "links.db"), "");
    linkSync(join(d, "links.db"), join(d, "auth.db"));
    expect(() =>
      authConfig({ ...AUTH, AYE_DB: join(d, "links.db"), AYE_AUTH_DB: join(d, "auth.db") }),
    ).toThrow("AYE_AUTH_DB must be a different file from AYE_DB.");
  });

  it("refuses a not-yet-created auth path that reaches the links file through a symlinked folder", () => {
    const d = scratch();
    symlinkSync(d, join(d, "alias"));
    expect(() =>
      authConfig({ ...AUTH, AYE_DB: join(d, "links.db"), AYE_AUTH_DB: join(d, "alias/links.db") }),
    ).toThrow("AYE_AUTH_DB must be a different file from AYE_DB.");
  });

  it("accepts two distinct files in the same folder", () => {
    const d = scratch();
    writeFileSync(join(d, "links.db"), "");
    writeFileSync(join(d, "auth.db"), "");
    const env = { ...AUTH, AYE_DB: join(d, "links.db"), AYE_AUTH_DB: join(d, "auth.db") };
    expect(authConfig(env).dbPath).toBe(join(d, "auth.db"));
  });

  it.each(["BETTER_AUTH_TRUSTED_ORIGINS", "BETTER_AUTH_URL", "BETTER_AUTH_SECRET"])(
    "refuses to run with %s set, even when empty",
    (name) => {
      expect(() => authConfig({ ...AUTH, [name]: "" })).toThrow(
        `Unset ${name}: better-auth reads BETTER_AUTH_* variables, and this server takes its auth settings only from AYE_ variables.`,
      );
    },
  );
});

describe("serverConfig", () => {
  const base = AUTH;
  const auth = authConfig(AUTH);

  it("defaults the port to 3002, leaves allowed hosts unset and reads the version file", () => {
    expect(serverConfig(base)).toEqual({
      dbPath: "/data/links.db",
      port: 3002,
      auth,
      savedCopies: savedCopyConfig({}),
      version: appVersion(),
    });
  });

  it("refuses a missing database like the key CLI does", () => {
    expect(() => serverConfig({})).toThrow("AYE_DB");
  });

  it("refuses to start without the auth settings", () => {
    expect(() => serverConfig({ AYE_DB: "/data/links.db" })).toThrow("AYE_AUTH_DB");
  });

  it("refuses to start with a BETTER_AUTH_ variable set", () => {
    expect(() =>
      serverConfig({ ...base, BETTER_AUTH_TRUSTED_ORIGINS: "https://x.example" }),
    ).toThrow("Unset BETTER_AUTH_TRUSTED_ORIGINS");
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

describe("savedCopyConfig", () => {
  let home = "";
  afterEach(() => {
    if (home) rmSync(home, { recursive: true, force: true });
    home = "";
  });
  const fresh = () => {
    home = realpathSync(mkdtempSync(join(tmpdir(), "aye-copies-")));
    return home;
  };
  const GIB = 1024 ** 3;
  const INSIDE = "must not be inside ~/.aye-links/releases or ~/.aye-links/current";

  it("defaults to ~/.aye-links/saved-copies and 1 GiB", () => {
    const h = fresh();
    expect(savedCopyConfig({}, h)).toEqual({
      dir: join(h, ".aye-links", "saved-copies"),
      limitBytes: GIB,
    });
  });

  it("accepts an absolute folder and reads the limit in GiB", () => {
    const h = fresh();
    const dir = join(h, "elsewhere");
    expect(savedCopyConfig({ AYE_SAVED_COPY_DIR: dir, AYE_SAVED_COPY_LIMIT_GB: "0.5" }, h)).toEqual(
      { dir, limitBytes: GIB / 2 },
    );
  });

  it("reads 0 as no new copies", () => {
    expect(savedCopyConfig({ AYE_SAVED_COPY_LIMIT_GB: "0" }, fresh()).limitBytes).toBe(0);
  });

  it.each(["-1", "abc", "1e3", "", " 1", "Infinity"])("refuses the limit %j", (limit) => {
    expect(() => savedCopyConfig({ AYE_SAVED_COPY_LIMIT_GB: limit }, fresh())).toThrow(
      "AYE_SAVED_COPY_LIMIT_GB must be a number of GiB, 0 or more.",
    );
  });

  it("refuses a relative folder", () => {
    expect(() => savedCopyConfig({ AYE_SAVED_COPY_DIR: "copies" }, fresh())).toThrow(
      "AYE_SAVED_COPY_DIR must be an absolute path.",
    );
  });

  it("refuses a folder inside the releases folder, or the folder itself", () => {
    const h = fresh();
    const releases = join(h, ".aye-links", "releases");
    expect(() => savedCopyConfig({ AYE_SAVED_COPY_DIR: join(releases, "x") }, h)).toThrow(INSIDE);
    expect(() => savedCopyConfig({ AYE_SAVED_COPY_DIR: releases }, h)).toThrow(INSIDE);
  });

  it("refuses a folder reached through the current symlink", () => {
    const h = fresh();
    mkdirSync(join(h, ".aye-links", "releases", "v1"), { recursive: true });
    symlinkSync(join(h, ".aye-links", "releases", "v1"), join(h, ".aye-links", "current"));
    expect(() =>
      savedCopyConfig({ AYE_SAVED_COPY_DIR: join(h, ".aye-links", "current", "copies") }, h),
    ).toThrow(INSIDE);
  });

  describe("by folder identity", () => {
    const release = (h: string) => {
      mkdirSync(join(h, ".aye-links", "releases", "v1"), { recursive: true });
      symlinkSync(join(h, ".aye-links", "releases", "v1"), join(h, ".aye-links", "current"));
    };

    it("refuses another spelling of the releases folder", (ctx) => {
      const h = fresh();
      release(h);
      if (!existsSync(join(h, ".aye-links", "RELEASES"))) return ctx.skip(); // case-sensitive volume
      expect(() =>
        savedCopyConfig({ AYE_SAVED_COPY_DIR: join(h, ".aye-links", "RELEASES", "x") }, h),
      ).toThrow(INSIDE);
    });

    it("refuses a folder reached through a symlink to a release", () => {
      const h = fresh();
      release(h);
      symlinkSync(join(h, ".aye-links", "releases", "v1"), join(h, "elsewhere"));
      expect(() => savedCopyConfig({ AYE_SAVED_COPY_DIR: join(h, "elsewhere", "x") }, h)).toThrow(
        INSIDE,
      );
    });

    it("refuses a path under a release tree that does not exist yet", () => {
      const h = fresh();
      expect(() =>
        savedCopyConfig(
          { AYE_SAVED_COPY_DIR: join(h, ".aye-links", "releases", "v1", "copies") },
          h,
        ),
      ).toThrow(INSIDE);
    });
  });

  it("accepts a sibling whose name only starts like releases", () => {
    const h = fresh();
    const dir = join(h, ".aye-links", "releases-copies");
    expect(savedCopyConfig({ AYE_SAVED_COPY_DIR: dir }, h).dir).toBe(dir);
  });
});
