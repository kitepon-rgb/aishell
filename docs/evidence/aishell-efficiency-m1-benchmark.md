# High-density runtime benchmark evidence

- Control: `aishell-efficiency-20260719`
- Date: 2026-07-19
- Codex: `codex-cli 0.144.6`
- Model: `gpt-5.6-sol`, reasoning `medium`
- Isolation: `--ephemeral --ignore-user-config --ignore-rules`, `approval_policy="never"`, `workspace-write`, per-run state directory
- Primary formula: total tokens across all attempts / deterministic oracle successes

## Valid capability evidence

The final candidate completed all five tools in one isolated Codex run. The oracle now requires each named tool to finish successfully, rather than checking only that the fixture remained unchanged.

The default profile contains five tools. The full compatibility profile contains 25. `TextContent` carries model-facing payload while `structuredContent` removes duplicated artifact/context/search text.

The host has no `rtk` executable. The runner records the inherited `PATH` hash and RTK detection result and refuses a formal run if RTK is found. Codex native output handling remains part of the native product baseline.

## Invalid exploratory evidence

Earlier runs found useful defects: forced routing hurt tiny tasks, high-volume diagnostics justified retained artifacts, and missing PATH ownership caused retries. However, the published 1.54% token increase / 11.3% time reduction combined records from different binary hashes and post-hoc prompt/PATH changes. That aggregate is invalid and is not release evidence.

## Formal run

Pending one same-invocation run of both arms, three sentinel tasks, and three repetitions using one binary, prompt manifest, repository state, sandbox, timeout, and model configuration. AIShell routing is oracle-gated per task (`run_check` for noisy compile; `workspace_snapshot` for repeated workspace observation).
