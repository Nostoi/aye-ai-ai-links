import type { NameVectors } from "../core/tag-suggest.js";
import type { Embedder } from "./embedder.js";

/**
 * Tag-name vectors over the search embedder, kept for the life of the process. A name is embedded
 * on its own, as a document: names embedded together score differently (2026-10-24-tag-merge-suggestions-design.md).
 * Asks made while a name is pending share its one embedding; a failed one is dropped so a later ask retries.
 */
export function createNameVectors(embedder: Embedder): NameVectors {
  const cache = new Map<string, Promise<Float32Array>>();
  return {
    vectorOf(name) {
      const cached = cache.get(name);
      if (cached) return cached;
      const pending = embedder.embedDocuments([name]).then(([vector]) => {
        if (!vector) throw new Error(`no vector for tag name ${name}`);
        return vector;
      });
      cache.set(name, pending);
      pending.catch(() => {
        if (cache.get(name) === pending) cache.delete(name);
      });
      return pending;
    },
  };
}
