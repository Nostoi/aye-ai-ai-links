import { MANIFEST, revisionDir } from "../search/model.js";
import { installModelFiles } from "../search/model-files.js";
import { loadTransformersEmbedder } from "../search/transformers-embedder.js";

/** Downloads what is missing, then checks the files and the canary. Returns the folder. */
export async function prefetchModel(
  root: string,
  fetchFn: (url: string) => Promise<Response> = fetch,
): Promise<string> {
  const dir = revisionDir(root);
  await installModelFiles(dir, MANIFEST, fetchFn);
  await loadTransformersEmbedder(dir);
  return dir;
}
