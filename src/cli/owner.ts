import { authOptions, createAuth, migrateAuth, openAuthDatabase } from "../auth/better-auth.js";
import { checkOwnerLogin, setOwnerLogin } from "../auth/owner-login.js";
import { authConfig, type Env } from "../config.js";

const USAGE = "Usage: owner set <email>, with the password on stdin";

const SERVER_RUNNING =
  "The auth database is in use, so the server is probably running. Stop the server first: launchctl bootout gui/$(id -u)/com.aye-links";

/** One trailing newline is what `echo` or a typed line adds; anything else is the password. */
const stripNewline = (s: string) => s.replace(/\r?\n$/, "");

const busy = (error: unknown) =>
  typeof error === "object" && error !== null && "code" in error && error.code === "SQLITE_BUSY";

/**
 * Sets the owner's login. Runs only while the server is stopped: the server holds the auth
 * database for its whole life, so an open that fails busy changes nothing. Checks the email and
 * password before it opens anything, then migrates and writes in one transaction.
 */
export async function run(
  argv: string[],
  env: Env,
  readPassword: () => Promise<string>,
  out: (line: string) => void,
  err: (line: string) => void,
): Promise<number> {
  const [command, email, ...extra] = argv;
  if (command !== "set" || email === undefined || extra.length > 0) {
    err(USAGE);
    return 1;
  }
  try {
    const config = authConfig(env);
    const password = stripNewline(await readPassword());
    checkOwnerLogin(email, password);
    let db: ReturnType<typeof openAuthDatabase>;
    try {
      db = openAuthDatabase(config.dbPath);
    } catch (error) {
      if (busy(error)) {
        err(SERVER_RUNNING);
        return 1;
      }
      throw error;
    }
    try {
      const options = authOptions({ db, secret: config.secret, baseUrl: config.baseUrl });
      await migrateAuth(options);
      const { created } = await setOwnerLogin(createAuth(options).auth, {
        id: env.AYE_OWNER || "owner",
        name: env.AYE_OWNER_NAME || "Owner",
        email,
        password,
      });
      out(
        created
          ? `Created the owner login for ${email}.`
          : `Changed the owner login to ${email} and signed out every session.`,
      );
    } finally {
      db.close();
    }
    return 0;
  } catch (error) {
    err(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
