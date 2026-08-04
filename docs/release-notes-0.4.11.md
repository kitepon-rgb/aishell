# AIShell 0.4.11

AIShell 0.4.11 lets `search_context` use one existing regular file as its search scope.

## Fixed

- `search_context(path: ...)` previously accepted only directories, while its public schema called the field a
  search root and did not expose that restriction. A fresh managed Claude therefore selected the valid tracked
  `README.md` file and received `INVALID_PATH` instead of search results.
- Lexical fixed-string and regex queries now pass a file directly to the `rg` worker while using its parent as the
  worker's current directory. They do not widen the search to sibling files.
- Glob queries use the attested workspace index as before, but a file scope admits only that exact indexed file.
- The public tool schema and README now state that the scope may be a directory or one regular file.
- `ApplyChangeSetService` now constrains operation-gate results to `Sendable`, preserving the existing serialized
  execution contract while restoring compilation with the release CI's Swift 6.1 strict-concurrency checker.

## Verification

- Focused core coverage fixes both lexical and glob file scopes and proves that a sibling file is not returned.
- The MCP wire fixture covers the legacy single-`query` request used by Claude and proves that it does not widen
  a file scope to a sibling containing the same text.
- Full Swift regression passed 567/567; the release-gate fixture passed 1/1 and the release app packaged successfully.
- The release smoke uses a fresh Aiterm-managed Claude session, calls the installed AIShell MCP directly without
  shell fallback, and requires both `runtime_status` and file-scoped `search_context` to succeed.

## Compatibility

Directory-scoped searches, ranking defaults, cursors, result shapes, and all tool names remain unchanged from 0.4.10.
