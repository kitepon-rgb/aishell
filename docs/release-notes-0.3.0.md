# AIShell 0.3.0 release notes

Date: 2026-07-19

AIShell 0.3.0 turns the direct-OS spike into a macOS state runtime for AI development.

## Added

- Default five-tool development profile: `workspace_snapshot`, `read_context`, `search_context`, `run_check`, and `artifact_read`.
- FSEvents-backed workspace journal reconciled against current file identity, metadata, and SHA-256.
- Filesystem-backed evidence store with TTL, quota, SHA-256, complete stdout/stderr retention, and bounded reads.
- Budgeted multi-file context reads and `rg`-backed search context.
- Isolated Codex benchmark runner with deterministic fixtures, usage records, raw events, and oracles.

## Changed

- `run_check` accepts an executable name and resolves it through `PATH`; command strings and shell executables remain rejected.
- The default MCP catalog exposes only the five high-density tools. Set `AISHELL_TOOL_PROFILE=full` for the 25-tool compatibility surface.
- MCP server and distribution versions are now 0.3.0.

## Measured result

The final same-binary, same-manifest three-task sentinel is pending. Earlier exploratory runs are not release evidence because records from different candidates were combined. No token-saving claim is made until the formal report is complete.

## Known limits

- Initial full workspace entries are a bounded preview; `omittedEntries` reports rows outside that preview. Delta reads are cursor-paged.
- The stdio server handles one request at a time. MCP cancellation and concurrent run polling are not implemented in 0.3.
- `run_check` annotations describe its focused-check intent, not a security boundary. A selected worker may have filesystem or network side effects.

See [M1 benchmark evidence](evidence/aishell-efficiency-m1-benchmark.md) for conditions and retained decisions.
