import { run } from "./keys.js";

process.exitCode = run(process.argv.slice(2), process.env, console.log, console.error);
