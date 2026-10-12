import { MANIFEST, revisionDir } from "../search/model.js";
import { installModelFiles } from "../search/model-files.js";
import { loadTransformersEmbedder } from "../search/transformers-embedder.js";

export type PrefetchDeps = {
  fetchFn?: (url: string) => Promise<Response>;
  install?: typeof installModelFiles;
  load?: (dir: string) => Promise<unknown>;
};

/** Downloads what is missing, then checks the files and the canary. Returns the folder. */
export async function prefetchModel(
  root: string,
  {
    fetchFn = fetch,
    install = installModelFiles,
    load = loadTransformersEmbedder,
  }: PrefetchDeps = {},
): Promise<string> {
  const dir = revisionDir(root);
  await install(dir, MANIFEST, fetchFn);
  await load(dir);
  return dir;
}
