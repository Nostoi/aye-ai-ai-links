# AGENTS.md for src/fetch

Files the extraction child process loads (`extract-child.ts`, `extract.ts`, `extract-metadata.ts`, `extract-text.ts`, `cap.ts`) import each other with `.ts` names, and use only TypeScript that Node can strip: no enums, namespaces or parameter properties. Node runs the child straight from `src/` under test; `tsc` rewrites the names to `.js` for `dist/`. Everything else keeps `.js` names.

The child's first message after getting the page is `received`, sent before it parses anything. The runner reports any end before it as `spawn_failed` (retryable), and any end after it by content (`crashed`, `timeout`, `out_of_memory`). Test fixture children in `fixtures/` that stand for a child that has the page must send `received` first.

`extract-runner.test.ts` starts the real child and fails if either rule is broken. Add a file to this list when the child starts importing it.
