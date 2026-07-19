# ADR 0001: OS-owned high-density development runtime

- Status: accepted
- Date: 2026-07-19
- Control: `aishell-efficiency-20260719`

## Decision

AIShell will expose the initial development surface as five outcome-oriented tools: `run_check`, `artifact_read`, `workspace_snapshot`, `read_context`, and `search_context`.

The tools share one macOS state runtime owned below the model:

1. Foundation `Process` launches an executable URL and argument array directly. Shell command strings remain unsupported.
2. Every `run_check` returns a structured result and immutable stdout/stderr artifacts under `RuntimeStore.baseDirectory`. AIShell 0.3 does not persist a separate run record.
3. Ordinary responses contain bounded summaries, explicit omission counts, freshness, and opaque handles. Complete bytes are retrieved only through `artifact_read` while retention is valid.
4. Workspace state is root-scoped. Initial state comes from a deterministic scan; FSEvents marks paths dirty and advances a journal cursor. Current file identity, metadata, and hash decide truth.
5. Dropped events, wrapped IDs, changed roots, or expired generations return an explicit rescan/cursor error. They never trigger a silent full-scan fallback.
6. Git, `rg`, compiler, and test executables are workers launched and observed by AIShell. They enrich OS-owned state but do not own it.
7. Existing primitive tools remain compatible during the initial rollout. The five new tools use a versioned top-level object result and stable error codes; legacy-wide refactoring is outside the first vertical slice.
8. The default profile contains exactly the five high-density tools. `AISHELL_TOOL_PROFILE=full` exposes the five plus the 20 legacy primitives.
9. Executable names are resolved by AIShell through `PATH` before direct launch. Shell executables, relative paths containing `/`, and command strings remain rejected.
10. TextContent is a concise model-facing projection. `structuredContent` remains an object-shaped metadata projection and does not duplicate large file or artifact contents.
11. `run_check` truthfully advertises destructive and open-world capability because a caller-selected worker can write files, start descendants, or access the network. Formal benchmarks use Codex bypass mode only inside disposable deterministic fixtures; normal hosts may require approval.
12. The basename denial of `sh`, `bash`, `zsh`, `dash`, `ksh`, `csh`, `tcsh`, `fish`, `env`, and `osascript` is a product rail, not a security boundary. It prevents the public API from collapsing into a generic command-string wrapper, but renamed binaries and descendants launched by an allowed worker remain possible. Authorization and isolation must not rely on this list.

## Rejected alternatives

- Returning truncated stdout/stderr in the normal response: this loses primary evidence and still spends model context on routine logs.
- Keeping temporary logs only: a summary cannot be audited or selectively expanded after the call.
- Treating FSEvents as a complete history or rename ledger: documented drop and coalescing behavior cannot support that guarantee.
- Implementing wrappers for every Git/compiler/LSP operation: this recreates a generic toolbox and removes Direct OS as the source of efficiency.

## Compatibility boundary

`process_run` keeps its current response in the compatibility surface. New high-density results do not rely on clients rendering `structuredContent` alone: their TextContent is a concise human-readable projection, not a duplicate serialization of the full object.

AIShell 0.3 processes one stdio request at a time. `run_check` owns timeout, exit status, descendant termination on timeout, and retained streams, but it does not implement MCP cancellation or concurrent polling. Initial full workspace entries are a bounded preview; `omittedEntries` reports excluded preview rows, while subsequent deltas are cursor-paged.
