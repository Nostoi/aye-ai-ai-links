import { text } from "node:stream/consumers";
import { run } from "./owner.js";

process.exitCode = await run(
  process.argv.slice(2),
  process.env,
  () => text(process.stdin),
  console.log,
  console.error,
);
