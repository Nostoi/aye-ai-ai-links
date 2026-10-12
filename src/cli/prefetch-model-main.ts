import { modelRoot } from "../config.js";
import { prefetchModel } from "./prefetch-model.js";

// Exits explicitly: the loaded model keeps native threads alive.
try {
  const dir = await prefetchModel(modelRoot());
  console.log(`Meaning-search model is installed and checked in ${dir}.`);
  process.exit(0);
} catch (err) {
  console.error(
    `Meaning-search model is not ready: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
}
