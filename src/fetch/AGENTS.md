# AGENTS.md for src/fetch

Files the extraction child process loads (`extract-child.ts`, `extract.ts`, `extract-metadata.ts`, `extract-text.ts`, `cap.ts`) import each other with `.ts` names, and use only TypeScript that Node can strip: no enums, namespaces or parameter properties. Node runs the child straight from `src/` under test; `tsc` rewrites the names to `.js` for `dist/`. Everything else keeps `.js` names.

`extract-runner.test.ts` starts the real child and fails if either rule is broken. Add a file to this list when the child starts importing it.
