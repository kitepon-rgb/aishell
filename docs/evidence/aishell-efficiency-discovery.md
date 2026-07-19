# High-density OS runtime discovery

- Control: `aishell-efficiency-20260719`
- Observed: 2026-07-19
- Source baseline: `3bda1c26bbc31e9fdb05250f9fcdb069bdbf8ae0`

## Existing seams

- `NativeProcessService` already launches an absolute executable URL through Foundation `Process` without a shell and writes stdout/stderr to files, avoiding pipe backpressure deadlock.
- Those files live in a temporary directory that is deleted before the call returns. Only the first 1 MiB of each stream survives in `ProcessExecutionResult`.
- `MCPServer` owns one `RuntimeStore` and lazily shares it with file/process services. This is the minimal composition seam for a persistent evidence and workspace runtime.
- `MCPServer.callTool` serializes the complete structured result again into TextContent. Large results are therefore duplicated at the protocol boundary.
- The current catalog has input schemas but no `outputSchema`; arguments are decoded ad hoc in the dispatcher.
- `AllowedPathResolver` already recognizes configured roots and reciprocal Git linked worktrees. New context tools can reuse it instead of establishing a second root policy.

## Consequence

Phase 1 should preserve `process_run` compatibility and promote its direct-execution core into a retained run/evidence path. `run_check` returns a bounded summary and artifact handles; `artifact_read` is the only lossless retrieval surface. Phase 2 should build one root-scoped state runtime above `AllowedPathResolver`, using FSEvents only as an invalidator and current filesystem identity/hash as truth.

No known matching caveat was found for the FSEvents, Swift Process, or MCP artifact queries before this inspection.
