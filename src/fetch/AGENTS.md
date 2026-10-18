# AGENTS.md for src/fetch

Files the extraction child process loads (`extract-child.ts`, `extract.ts`, `extract-metadata.ts`, `extract-text.ts`, `extract-copy.ts`, `../core/saved-copy.ts`, `cap.ts`) import each other with `.ts` names, and use only TypeScript that Node can strip: no enums, namespaces or parameter properties. Node runs the child straight from `src/` under test; `tsc` rewrites the names to `.js` for `dist/`. Everything else keeps `.js` names.

The child's first message after getting the page is `received`, sent before it parses anything; then `metadata`, `text`, and, when asked, `copy`. The runner reports any end before `received` other than an abort or `close()` (`aborted`) as `spawn_failed` (retryable), and so a lost channel at any point, even after it, with one exception: once `metadata` and `text` are in, any end (an abort, `close()` or a lost channel included) is `ok`, without a copy if none arrived. After it, a crash, a timeout or running out of memory are content failures (`crashed`, `timeout`, `out_of_memory`). See the ROADMAP #30 PR B entry. Test fixture children in `fixtures/` that stand for a child that has the page must send `received` first.

`extract-runner.test.ts` starts the real child and fails if either rule is broken. Add a file to this list when the child starts importing it.
